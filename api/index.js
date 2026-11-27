const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');
const store = require('../lib/store');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Serve static files for local Express usage
app.use(express.static(path.join(__dirname, '..', 'public')));

// Use memory storage so file uploads work on Vercel serverless (read-only FS)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ─── Helpers ───
async function generateCode() {
  let code;
  let attempts = 0;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
    attempts++;
  } while ((await store.getSessionMeta(code)) && attempts < 20);
  return code;
}

function getTimeLeft(session) {
  if (!session || session.status !== 'active' || !session.questionRevealed) return 0;
  const q = session.quiz.questions[session.currentQuestionIndex];
  if (!q || !session.questionStartedAt) return 0;
  const elapsedMs = Date.now() - session.questionStartedAt;
  return Math.max(0, Math.ceil((q.timer * 1000 - elapsedMs) / 1000));
}

// ─── Health Check ───
app.get('/api/health', (req, res) => {
  res.json({ ok: true, storage: store.mode, timestamp: new Date().toISOString() });
});

// ─── Quiz CRUD ───
app.post('/api/quiz', async (req, res) => {
  try {
    const title = (req.body.title || '').trim() || 'Untitled Quiz';
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    const quiz = {
      id: uuidv4(),
      title,
      questions,
      createdAt: new Date().toISOString()
    };
    await store.saveQuiz(quiz);
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quizzes', async (req, res) => {
  try {
    const list = await store.listQuizzes();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quiz/:id', async (req, res) => {
  try {
    const quiz = await store.getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/quiz/:id', async (req, res) => {
  try {
    const quiz = await store.getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    if (typeof req.body.title === 'string' && req.body.title.trim()) {
      quiz.title = req.body.title.trim();
    }
    if (Array.isArray(req.body.questions)) {
      quiz.questions = req.body.questions;
    }
    await store.saveQuiz(quiz);
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/quiz/:id', async (req, res) => {
  try {
    await store.deleteQuiz(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── File Import (Buffer-based for Vercel) ───
app.post('/api/quiz/:id/import', upload.single('file'), async (req, res) => {
  try {
    const quiz = await store.getQuiz(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let questions = [];

    if (ext === '.txt') {
      const text = req.file.buffer.toString('utf-8');
      questions = parsePlainText(text);
    } else if (ext === '.pdf') {
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      const data = await pdfParse(req.file.buffer);
      questions = parsePlainText(data.text);
    } else if (ext === '.xlsx' || ext === '.xls') {
      const XLSX = require('xlsx');
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      questions = parseSpreadsheet(rows);
    } else if (ext === '.docx' || ext === '.doc') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      questions = parsePlainText(result.value);
    } else {
      return res.status(400).json({ error: 'Unsupported file format. Use .txt, .pdf, .xlsx, or .docx' });
    }

    if (questions.length === 0) {
      return res.status(400).json({
        error: 'No valid questions found in file. Please check the format guide.'
      });
    }

    quiz.questions.push(...questions);
    await store.saveQuiz(quiz);
    res.json({ imported: questions.length, total: quiz.questions.length, questions });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Failed to parse file: ' + err.message });
  }
});

// ─── Live Session Endpoints ───

// Host creates a live session
app.post('/api/session', async (req, res) => {
  try {
    const quiz = await store.getQuiz(req.body.quizId);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    if (!quiz.questions || quiz.questions.length === 0) {
      return res.status(400).json({ error: 'Quiz has no questions' });
    }

    const code = await generateCode();
    const hostToken = uuidv4();
    const meta = {
      id: uuidv4(),
      code,
      hostToken,
      quiz: JSON.parse(JSON.stringify(quiz)),
      status: 'waiting', // waiting | active | ended
      currentQuestionIndex: -1,
      questionRevealed: false,
      questionStartedAt: null,
      createdAt: new Date().toISOString()
    };

    await store.saveSessionMeta(meta);
    res.json({
      code,
      hostToken,
      quizTitle: quiz.title,
      questionCount: quiz.questions.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public session info
app.get('/api/session/:code', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    const participants = await store.listParticipants(req.params.code);
    const activeCount = Object.values(participants).filter(p => !p.kicked).length;
    res.json({
      code: meta.code,
      quizTitle: meta.quiz.title,
      status: meta.status,
      participantCount: activeCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QR Code for joining
app.get('/api/session/:code/qr', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const joinUrl = `${proto}://${host}/join.html?code=${req.params.code}`;
    const qr = await QRCode.toDataURL(joinUrl, {
      width: 320,
      margin: 2,
      color: { dark: '#1a73e8', light: '#ffffff' }
    });
    res.json({ qr, url: joinUrl, code: req.params.code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Participant joins session
app.post('/api/session/:code/join', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Invalid session code' });
    if (meta.status === 'ended') return res.status(400).json({ error: 'This quiz session has already ended' });

    const name = (req.body.name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Please enter your name' });

    const existingId = req.body.participantId;
    if (existingId) {
      const existing = await store.getParticipant(req.params.code, existingId);
      if (existing) {
        if (existing.kicked) {
          return res.status(403).json({ error: existing.kickReason || 'You were removed by the host' });
        }
        return res.json({
          code: meta.code,
          participantId: existing.id,
          name: existing.name,
          quizTitle: meta.quiz.title,
          status: meta.status
        });
      }
    }

    const participantId = uuidv4();
    const participant = {
      id: participantId,
      name,
      kicked: false,
      kickReason: '',
      joinedAt: new Date().toISOString()
    };

    await store.addParticipant(req.params.code, participant);
    res.json({
      code: meta.code,
      participantId,
      name,
      quizTitle: meta.quiz.title,
      status: meta.status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Participant polls state (NEVER includes correctIndex or results)
app.get('/api/session/:code/state', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });

    const participantId = req.query.participantId;
    const participant = participantId ? await store.getParticipant(req.params.code, participantId) : null;
    if (!participant) return res.status(404).json({ error: 'Participant not found in session' });

    if (participant.kicked) {
      return res.json({
        status: 'kicked',
        kicked: true,
        kickReason: participant.kickReason || 'Removed by host'
      });
    }

    const idx = meta.currentQuestionIndex;
    const q = idx >= 0 && idx < meta.quiz.questions.length ? meta.quiz.questions[idx] : null;
    const timeLeft = getTimeLeft(meta);
    const ansRecord = q ? await store.getParticipantAnswer(req.params.code, q.id, participantId) : null;

    res.json({
      status: meta.status,
      kicked: false,
      quizTitle: meta.quiz.title,
      questionRevealed: meta.questionRevealed,
      currentQuestionIndex: idx,
      totalQuestions: meta.quiz.questions.length,
      timeLeft,
      answered: Boolean(ansRecord),
      selectedAnswer: ansRecord ? ansRecord.answerIndex : null,
      question: q && meta.status === 'active' ? {
        id: q.id,
        text: q.text,
        options: q.options,
        timer: q.timer
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Participant submits answer (Atomic per-participant write, NEVER reveals correctness)
app.post('/api/session/:code/answer', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (meta.status !== 'active' || !meta.questionRevealed) {
      return res.status(400).json({ error: 'Question is locked or not active' });
    }

    const { participantId, answerIndex } = req.body;
    const participant = participantId ? await store.getParticipant(req.params.code, participantId) : null;
    if (!participant || participant.kicked) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const q = meta.quiz.questions[meta.currentQuestionIndex];
    if (!q) return res.status(400).json({ error: 'No active question' });

    const elapsedMs = Date.now() - (meta.questionStartedAt || Date.now());
    if (elapsedMs > (q.timer + 2) * 1000) {
      return res.status(400).json({ error: 'Time expired' });
    }

    const basePoints = Number(q.points) > 0 ? Number(q.points) : 1000;
    let earned = 0;
    if (Number(answerIndex) === q.correctIndex) {
      const totalMs = Math.max(1000, (q.timer || 30) * 1000);
      const ratio = Math.max(0, Math.min(1, (totalMs - elapsedMs) / totalMs));
      earned = Math.round(basePoints * (0.5 + 0.5 * ratio));
    }

    const inserted = await store.submitAnswer(req.params.code, q.id, participantId, {
      answerIndex: Number(answerIndex),
      score: earned,
      answeredAt: Date.now()
    });

    if (!inserted) {
      return res.json({ confirmed: true, alreadyAnswered: true });
    }

    res.json({ confirmed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Participant anti-cheat report (Atomic list push)
app.post('/api/session/:code/cheat', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });

    const { participantId, type, detail } = req.body;
    const participant = participantId ? await store.getParticipant(req.params.code, participantId) : null;
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    const record = {
      id: uuidv4(),
      participantId,
      participantName: participant.name,
      type: type || 'unknown',
      detail: detail || '',
      time: new Date().toISOString()
    };

    await store.addCheat(req.params.code, record);
    res.json({ logged: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host polls full state
app.get('/api/session/:code/host-state', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (req.query.hostToken !== meta.hostToken) {
      return res.status(403).json({ error: 'Unauthorized host token' });
    }

    const idx = meta.currentQuestionIndex;
    const q = idx >= 0 && idx < meta.quiz.questions.length ? meta.quiz.questions[idx] : null;
    const qIds = meta.quiz.questions.map(item => item.id);

    const [rawParticipants, allAnswers, cheatLog] = await Promise.all([
      store.listParticipants(req.params.code),
      store.getAllSessionAnswers(req.params.code, qIds),
      store.getCheats(req.params.code, 50)
    ]);

    const cheatCountsByPid = {};
    for (const c of cheatLog) {
      cheatCountsByPid[c.participantId] = (cheatCountsByPid[c.participantId] || 0) + 1;
    }

    const answerCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let responseCount = 0;

    const participants = Object.values(rawParticipants)
      .filter(p => !p.kicked)
      .map(p => {
        let score = 0;
        let correctCount = 0;
        for (const item of meta.quiz.questions) {
          const ansRec = allAnswers[item.id] ? allAnswers[item.id][p.id] : null;
          if (ansRec) {
            score += ansRec.score || 0;
            if (ansRec.answerIndex === item.correctIndex) correctCount++;
          }
        }
        const currentAns = q && allAnswers[q.id] ? allAnswers[q.id][p.id] : null;
        const answeredCurrent = Boolean(currentAns);
        if (answeredCurrent) {
          responseCount++;
          if (answerCounts[currentAns.answerIndex] !== undefined) {
            answerCounts[currentAns.answerIndex]++;
          }
        }
        return {
          id: p.id,
          name: p.name,
          score,
          correctCount,
          answeredCurrent,
          cheats: cheatCountsByPid[p.id] || 0
        };
      })
      .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount);

    res.json({
      code: meta.code,
      quizTitle: meta.quiz.title,
      status: meta.status,
      currentQuestionIndex: idx,
      totalQuestions: meta.quiz.questions.length,
      questionRevealed: meta.questionRevealed,
      timeLeft: getTimeLeft(meta),
      question: q ? {
        id: q.id,
        text: q.text,
        options: q.options,
        correctIndex: q.correctIndex,
        timer: q.timer,
        points: Number(q.points) > 0 ? Number(q.points) : 1000
      } : null,
      participants,
      participantCount: participants.length,
      answerCounts,
      responseCount,
      cheatLog
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host advances to next question
app.post('/api/session/:code/next', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (req.body.hostToken !== meta.hostToken) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (meta.status === 'waiting') meta.status = 'active';
    meta.currentQuestionIndex++;

    if (meta.currentQuestionIndex >= meta.quiz.questions.length) {
      meta.status = 'ended';
      meta.questionRevealed = false;
      await store.saveSessionMeta(meta);
      return res.json({ status: 'ended' });
    }

    meta.questionRevealed = true;
    meta.questionStartedAt = Date.now();
    await store.saveSessionMeta(meta);

    const q = meta.quiz.questions[meta.currentQuestionIndex];
    res.json({
      status: meta.status,
      index: meta.currentQuestionIndex,
      total: meta.quiz.questions.length,
      question: q
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host locks current question
app.post('/api/session/:code/lock', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (req.body.hostToken !== meta.hostToken) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    meta.questionRevealed = false;
    await store.saveSessionMeta(meta);
    res.json({ locked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host ends session
app.post('/api/session/:code/end', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (req.body.hostToken !== meta.hostToken) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    meta.status = 'ended';
    meta.questionRevealed = false;
    await store.saveSessionMeta(meta);
    res.json({ status: 'ended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host kicks participant
app.post('/api/session/:code/kick', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (req.body.hostToken !== meta.hostToken) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const p = await store.getParticipant(req.params.code, req.body.participantId);
    if (p) {
      p.kicked = true;
      p.kickReason = req.body.reason || 'Removed by host due to anti-cheat violation';
      await store.addParticipant(req.params.code, p);
    }
    res.json({ kicked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host-only Results
app.get('/api/session/:code/results', async (req, res) => {
  try {
    const meta = await store.getSessionMeta(req.params.code);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (req.query.hostToken !== meta.hostToken) {
      return res.status(403).json({ error: 'Results are only visible to the host' });
    }

    const total = meta.quiz.questions.length;
    const maxScore = meta.quiz.questions.reduce((sum, q) => sum + (Number(q.points) > 0 ? Number(q.points) : 1000), 0);
    const qIds = meta.quiz.questions.map(item => item.id);

    const [rawParticipants, allAnswers, allCheats] = await Promise.all([
      store.listParticipants(req.params.code),
      store.getAllSessionAnswers(req.params.code, qIds),
      store.getCheats(req.params.code, 200)
    ]);

    const cheatsByPid = {};
    for (const c of allCheats) {
      if (!cheatsByPid[c.participantId]) cheatsByPid[c.participantId] = [];
      cheatsByPid[c.participantId].push(c);
    }

    const results = Object.values(rawParticipants).map(p => {
      let correct = 0;
      let score = 0;
      for (const q of meta.quiz.questions) {
        const ansRec = allAnswers[q.id] ? allAnswers[q.id][p.id] : null;
        if (ansRec) {
          score += ansRec.score || 0;
          if (ansRec.answerIndex === q.correctIndex) correct++;
        }
      }
      return {
        id: p.id,
        name: p.name,
        score,
        maxScore,
        correct,
        total,
        percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
        cheats: cheatsByPid[p.id] || [],
        kicked: p.kicked
      };
    });

    results.sort((a, b) => b.score - a.score || b.correct - a.correct);
    res.json({ quiz: meta.quiz.title, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── File Parsing Helpers ───
function parsePlainText(text) {
  const questions = [];
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n\s*\n/).filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    let questionText = '';
    const options = [];
    let correctIndex = 0;
    let timer = 30;
    let points = 1000;

    for (const line of lines) {
      if (/^(Q\d*[:.\s]|Question\s*\d*[:.\s]|\d+[.)]\s)/i.test(line)) {
        questionText = line.replace(/^(Q\d*[:.\s]|Question\s*\d*[:.\s]|\d+[.)]\s)/i, '').trim();
      } else if (/^\(?[A-Da-d][.)]\s/.test(line)) {
        options.push(line.replace(/^\(?[A-Da-d][.)]\s/, '').trim());
      } else if (/^(Answer|Correct|Ans)[:.\s]/i.test(line)) {
        const ans = line.replace(/^(Answer|Correct|Ans)[:.\s]*/i, '').trim().toUpperCase();
        const idx = 'ABCD'.indexOf(ans.charAt(0));
        if (idx >= 0) correctIndex = idx;
      } else if (/^(Timer|Time)[:.\s]/i.test(line)) {
        const t = parseInt(line.replace(/^(Timer|Time)[:.\s]*/i, ''), 10);
        if (t >= 5) timer = t;
      } else if (/^(Points|Pts|Score)[:.\s]/i.test(line)) {
        const pts = parseInt(line.replace(/^(Points|Pts|Score)[:.\s]*/i, ''), 10);
        if (pts >= 50) points = pts;
      } else if (!questionText) {
        questionText = line;
      } else if (options.length < 4) {
        options.push(line);
      }
    }

    if (questionText && options.length >= 2) {
      while (options.length < 4) options.push('');
      questions.push({
        id: uuidv4(),
        text: questionText,
        options: options.slice(0, 4),
        correctIndex: Math.min(correctIndex, 3),
        timer,
        points
      });
    }
  }
  return questions;
}

function parseSpreadsheet(rows) {
  const questions = [];
  const startRow = rows[0] && typeof rows[0][0] === 'string' && /question/i.test(rows[0][0]) ? 1 : 0;

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;

    const questionText = String(row[0]).trim();
    const options = [
      String(row[1] || '').trim(),
      String(row[2] || '').trim(),
      String(row[3] || '').trim(),
      String(row[4] || '').trim()
    ];
    const correct = String(row[5] || 'A').trim().toUpperCase();
    const timer = Math.max(5, parseInt(row[6], 10) || 30);
    const points = Math.max(50, parseInt(row[7], 10) || 1000);

    let correctIndex = 'ABCD'.indexOf(correct.charAt(0));
    if (correctIndex < 0) correctIndex = 0;

    if (questionText && options.filter(Boolean).length >= 2) {
      questions.push({
        id: uuidv4(),
        text: questionText,
        options,
        correctIndex,
        timer,
        points
      });
    }
  }
  return questions;
}

// JSON 404 fallback for API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found', path: req.originalUrl });
});

module.exports = app;
