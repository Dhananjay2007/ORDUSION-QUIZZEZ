const fs = require('fs');
const os = require('os');
const path = require('path');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_API_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const TMP_FILE = path.join(os.tmpdir(), 'ordusion-quizzez-store.json');

// In-memory fallback cache
let memoryStore = {
  quizzes: {},
  sessions: {}
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

const QUIZ_PREFIX = 'oq:quiz:';
const QUIZ_INDEX_KEY = 'oq:quizzes:index';
const SESSION_PREFIX = 'oq:session:';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

const store = {
  mode: USE_REDIS ? 'redis' : 'memory-tmp',

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
      await redisCommand(['SET', QUIZ_PREFIX + quiz.id, JSON.stringify(quiz)]);
      await redisCommand(['SADD', QUIZ_INDEX_KEY, quiz.id]);
      return quiz;
    }
    loadTmp();
    memoryStore.quizzes[quiz.id] = quiz;
    saveTmp();
    return quiz;
  },

  async deleteQuiz(id) {
    if (USE_REDIS) {
      await redisCommand(['DEL', QUIZ_PREFIX + id]);
      await redisCommand(['SREM', QUIZ_INDEX_KEY, id]);
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
      const keys = ids.map(id => QUIZ_PREFIX + id);
      const values = await redisCommand(['MGET', ...keys]);
      return values
        .filter(Boolean)
        .map(v => JSON.parse(v))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    loadTmp();
    return Object.values(memoryStore.quizzes)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async getSession(code) {
    if (USE_REDIS) {
      const raw = await redisCommand(['GET', SESSION_PREFIX + code]);
      return raw ? JSON.parse(raw) : null;
    }
    loadTmp();
    return memoryStore.sessions[code] || null;
  },

  async saveSession(session) {
    if (USE_REDIS) {
      await redisCommand([
        'SET',
        SESSION_PREFIX + session.code,
        JSON.stringify(session),
        'EX',
        String(SESSION_TTL_SECONDS)
      ]);
      return session;
    }
    loadTmp();
    memoryStore.sessions[session.code] = session;
    saveTmp();
    return session;
  }
};

module.exports = store;
