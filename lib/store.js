const fs = require('fs');
const os = require('os');
const path = require('path');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_API_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const TMP_FILE = path.join(os.tmpdir(), 'ordusion-quizzez-store-v2.json');

let memoryStore = {
  quizzes: {},
  sessions: {} // code -> { meta, participants: {}, answers: { qId: { pId: rec } }, cheats: [] }
};

function loadTmp() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      const raw = fs.readFileSync(TMP_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        memoryStore = {
          quizzes: parsed.quizzes || {},
          sessions: parsed.sessions || {}
        };
      }
    }
  } catch (e) {
    // ignore corrupt tmp file
  }
}

function saveTmp() {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(memoryStore), 'utf-8');
  } catch (e) {
    // ignore read-only fs errors
  }
}

loadTmp();

async function redisCommand(commandArgs) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commandArgs)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.result;
}

async function redisPipeline(commands) {
  const res = await fetch(`${REDIS_URL.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis pipeline error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.map(item => item.result);
}

function hgetallToObject(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i += 2) {
    try {
      out[arr[i]] = JSON.parse(arr[i + 1]);
    } catch (e) {
      // skip malformed
    }
  }
  return out;
}

const QUIZ_PREFIX = 'oq:quiz:';
const QUIZ_INDEX_KEY = 'oq:quizzes:index';
const SESSION_TTL = 60 * 60 * 12; // 12 hours

const metaKey = (code) => `oq:s:${code}:meta`;
const partKey = (code) => `oq:s:${code}:participants`;
const ansKey = (code, qId) => `oq:s:${code}:ans:${qId}`;
const cheatKey = (code) => `oq:s:${code}:cheats`;

const store = {
  mode: USE_REDIS ? 'redis' : 'memory-tmp',

  // ─── Quizzes ───
  async getQuiz(id) {
    if (USE_REDIS) {
      const raw = await redisCommand(['GET', QUIZ_PREFIX + id]);
      return raw ? JSON.parse(raw) : null;
    }
    loadTmp();
    return memoryStore.quizzes[id] || null;
  },

  async saveQuiz(quiz) {
    if (USE_REDIS) {
      await redisPipeline([
        ['SET', QUIZ_PREFIX + quiz.id, JSON.stringify(quiz)],
        ['SADD', QUIZ_INDEX_KEY, quiz.id]
      ]);
      return quiz;
    }
    loadTmp();
    memoryStore.quizzes[quiz.id] = quiz;
    saveTmp();
    return quiz;
  },

  async deleteQuiz(id) {
    if (USE_REDIS) {
      await redisPipeline([
        ['DEL', QUIZ_PREFIX + id],
        ['SREM', QUIZ_INDEX_KEY, id]
      ]);
      return;
    }
    loadTmp();
    delete memoryStore.quizzes[id];
    saveTmp();
  },

  async listQuizzes() {
    if (USE_REDIS) {
      const ids = await redisCommand(['SMEMBERS', QUIZ_INDEX_KEY]);
      if (!ids || !ids.length) return [];
      const values = await redisCommand(['MGET', ...ids.map(id => QUIZ_PREFIX + id)]);
      return values
        .filter(Boolean)
        .map(v => JSON.parse(v))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    loadTmp();
    return Object.values(memoryStore.quizzes)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  // ─── Sessions (Atomic per-participant & per-answer) ───
  async getSessionMeta(code) {
    if (USE_REDIS) {
      const raw = await redisCommand(['GET', metaKey(code)]);
      return raw ? JSON.parse(raw) : null;
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    return s ? s.meta : null;
  },

  async saveSessionMeta(meta) {
    if (USE_REDIS) {
      await redisCommand(['SET', metaKey(meta.code), JSON.stringify(meta), 'EX', String(SESSION_TTL)]);
      return meta;
    }
    loadTmp();
    if (!memoryStore.sessions[meta.code]) {
      memoryStore.sessions[meta.code] = { meta, participants: {}, answers: {}, cheats: [] };
    } else {
      memoryStore.sessions[meta.code].meta = meta;
    }
    saveTmp();
    return meta;
  },

  async addParticipant(code, participant) {
    if (USE_REDIS) {
      await redisPipeline([
        ['HSET', partKey(code), participant.id, JSON.stringify(participant)],
        ['EXPIRE', partKey(code), String(SESSION_TTL)]
      ]);
      return participant;
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    if (s) {
      s.participants[participant.id] = participant;
      saveTmp();
    }
    return participant;
  },

  async getParticipant(code, participantId) {
    if (USE_REDIS) {
      const raw = await redisCommand(['HGET', partKey(code), participantId]);
      return raw ? JSON.parse(raw) : null;
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    return s && s.participants[participantId] ? s.participants[participantId] : null;
  },

  async listParticipants(code) {
    if (USE_REDIS) {
      const raw = await redisCommand(['HGETALL', partKey(code)]);
      return hgetallToObject(raw);
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    return s ? s.participants : {};
  },

  // Atomic HSETNX so simultaneous answers never overwrite each other or allow double-submit
  async submitAnswer(code, questionId, participantId, answerRecord) {
    if (USE_REDIS) {
      const [inserted] = await redisPipeline([
        ['HSETNX', ansKey(code, questionId), participantId, JSON.stringify(answerRecord)],
        ['EXPIRE', ansKey(code, questionId), String(SESSION_TTL)]
      ]);
      return inserted === 1;
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    if (!s) return false;
    if (!s.answers[questionId]) s.answers[questionId] = {};
    if (s.answers[questionId][participantId] !== undefined) return false;
    s.answers[questionId][participantId] = answerRecord;
    saveTmp();
    return true;
  },

  async getParticipantAnswer(code, questionId, participantId) {
    if (USE_REDIS) {
      const raw = await redisCommand(['HGET', ansKey(code, questionId), participantId]);
      return raw ? JSON.parse(raw) : null;
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    return s && s.answers[questionId] ? (s.answers[questionId][participantId] || null) : null;
  },

  async getAllSessionAnswers(code, questionIds) {
    const result = {};
    if (!questionIds || !questionIds.length) return result;
    if (USE_REDIS) {
      const cmds = questionIds.map(qId => ['HGETALL', ansKey(code, qId)]);
      const responses = await redisPipeline(cmds);
      questionIds.forEach((qId, idx) => {
        result[qId] = hgetallToObject(responses[idx]);
      });
      return result;
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    if (!s) return result;
    for (const qId of questionIds) {
      result[qId] = s.answers[qId] || {};
    }
    return result;
  },

  async addCheat(code, record) {
    if (USE_REDIS) {
      const [len] = await redisPipeline([
        ['LPUSH', cheatKey(code), JSON.stringify(record)],
        ['LTRIM', cheatKey(code), '0', '199'],
        ['EXPIRE', cheatKey(code), String(SESSION_TTL)]
      ]);
      return len;
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    if (s) {
      s.cheats.unshift(record);
      if (s.cheats.length > 200) s.cheats.length = 200;
      saveTmp();
      return s.cheats.length;
    }
    return 0;
  },

  async getCheats(code, limit = 50) {
    if (USE_REDIS) {
      const raw = await redisCommand(['LRANGE', cheatKey(code), '0', String(limit - 1)]);
      return Array.isArray(raw) ? raw.map(item => JSON.parse(item)) : [];
    }
    loadTmp();
    const s = memoryStore.sessions[code];
    return s ? s.cheats.slice(0, limit) : [];
  }
};

module.exports = store;
