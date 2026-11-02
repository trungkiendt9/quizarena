import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const DATA_DIR = ROOT_DIR;
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PUBLIC_APP_DIR = ROOT_DIR;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
  }
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));

// Ensure iframe embedding in Arena preview is never blocked
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// ==========================================
// IN-MEMORY GAME ROOMS STORE
// ==========================================
const rooms = new Map();

const BOT_PROFILES = [
  { nickname: 'Minh Anh - K68', avatar: '🦊' },
  { nickname: 'Hoàng Nam - CNTT', avatar: '🚀' },
  { nickname: 'Thảo Vy - KTĐN', avatar: '🦄' },
  { nickname: 'Đức Duy - AI', avatar: '🤖' },
  { nickname: 'Phương Linh', avatar: '🐼' },
  { nickname: 'Quốc Bảo - K67', avatar: '🐯' },
  { nickname: 'Ngọc Hân', avatar: '🌟' },
  { nickname: 'Tuấn Kiệt', avatar: '⚡' },
  { nickname: 'Khánh Huyền', avatar: '🦉' },
  { nickname: 'Gia Huy - ĐTVT', avatar: '🐉' },
  { nickname: 'Thanh Trúc', avatar: '🐱' },
  { nickname: 'Nhật Minh', avatar: '🎓' },
];

function generatePin() {
  let pin = '';
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(pin));
  return pin;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function prepareQuestions(rawQuestions, settings) {
  let list = rawQuestions.map((q) => ({
    ...q,
    options: [...q.options],
    correctIndices: [...q.correctIndices],
  }));

  if (settings?.shuffleQuestions) {
    list = shuffleArray(list);
  }

  if (settings?.shuffleOptions) {
    list = list.map((q) => {
      if (q.type === 'true_false') return q; // Keep Đúng / Sai order intuitive
      const indexed = q.options.map((opt, idx) => ({
        opt,
        isCorrect: q.correctIndices.includes(idx),
      }));
      const shuffled = shuffleArray(indexed);
      return {
        ...q,
        options: shuffled.map((item) => item.opt),
        correctIndices: shuffled
          .map((item, idx) => (item.isCorrect ? idx : -1))
          .filter((idx) => idx !== -1),
      };
    });
  }

  return list;
}

function clearRoomTimers(room) {
  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }
  if (room.botTimers && room.botTimers.length > 0) {
    room.botTimers.forEach((t) => clearTimeout(t));
    room.botTimers = [];
  }
}

function getSortedPlayers(room) {
  return Array.from(room.players.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    return (a.totalResponseMs || 0) - (b.totalResponseMs || 0);
  });
}

function serializePlayersPublic(room) {
  const sorted = getSortedPlayers(room);
  return sorted.map((p, index) => ({
    id: p.id,
    nickname: p.nickname,
    avatar: p.avatar,
    score: p.score,
    streak: p.streak,
    bestStreak: p.bestStreak,
    correctCount: p.correctCount,
    isBot: p.isBot,
    connected: p.connected,
    rank: p.rank || index + 1,
    rankDelta: p.rankDelta || 0,
    lastPointsEarned: p.lastPointsEarned || 0,
    hasAnsweredCurrent:
      room.status === 'question'
        ? Boolean(p.answers[room.currentQuestionIndex])
        : false,
  }));
}

function buildPublicQuestion(room, includeAnswer = false) {
  const q = room.questions[room.currentQuestionIndex];
  if (!q) return null;
  const base = {
    index: room.currentQuestionIndex,
    total: room.questions.length,
    id: q.id,
    type: q.type,
    question: q.question,
    codeSnippet: q.codeSnippet || '',
    options: q.options,
    timeLimit: q.timeLimit || 20,
    pointsMultiplier: q.pointsMultiplier ?? 1,
    startedAt: room.questionStartedAt,
    endsAt: room.questionEndsAt,
    serverNow: Date.now(),
  };
  if (includeAnswer) {
    base.correctIndices = q.correctIndices;
    base.explanation = q.explanation || '';
    base.optionCounts = room.lastOptionCounts || q.options.map(() => 0);
  }
  return base;
}

function buildHostState(room) {
  const includeAnswer =
    room.status === 'reveal' ||
    room.status === 'leaderboard' ||
    room.status === 'podium';
  const currentQ = buildPublicQuestion(room, includeAnswer);
  const players = serializePlayersPublic(room);
  const answeredCount =
    room.status === 'question'
      ? Array.from(room.players.values()).filter(
          (p) => p.answers[room.currentQuestionIndex]
        ).length
      : room.lastAnsweredCount || 0;

  return {
    pin: room.pin,
    quizId: room.quiz.id,
    quizTitle: room.quiz.title,
    quizCategory: room.quiz.category,
    coverEmoji: room.quiz.coverEmoji,
    status: room.status,
    settings: room.settings,
    totalQuestions: room.questions.length,
    currentQuestionIndex: room.currentQuestionIndex,
    currentQuestion: currentQ,
    countdownEndsAt: room.countdownEndsAt,
    serverNow: Date.now(),
    players,
    playerCount: room.players.size,
    answeredCount,
  };
}

function buildPlayerState(room, player) {
  const includeAnswer =
    room.status === 'reveal' ||
    room.status === 'leaderboard' ||
    room.status === 'podium';
  const q = buildPublicQuestion(room, includeAnswer);

  // If teacher turned off showing text on student devices during active question
  let sanitizedQuestion = q;
  if (q && !room.settings.showTextOnDevices && room.status === 'question') {
    sanitizedQuestion = {
      ...q,
      question: '',
      codeSnippet: '',
      options: q.options.map(() => ''),
    };
  }

  const currentSubmission =
    room.currentQuestionIndex >= 0
      ? player.answers[room.currentQuestionIndex] || null
      : null;

  const sorted = getSortedPlayers(room);
  const myIndex = sorted.findIndex((p) => p.id === player.id);
  const myRank = myIndex >= 0 ? myIndex + 1 : room.players.size;
  const aheadPlayer = myIndex > 0 ? sorted[myIndex - 1] : null;

  return {
    pin: room.pin,
    quizTitle: room.quiz.title,
    status: room.status,
    settings: room.settings,
    totalQuestions: room.questions.length,
    currentQuestionIndex: room.currentQuestionIndex,
    currentQuestion: sanitizedQuestion,
    countdownEndsAt: room.countdownEndsAt,
    serverNow: Date.now(),
    playerCount: room.players.size,
    me: {
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      score: player.score,
      streak: player.streak,
      bestStreak: player.bestStreak,
      correctCount: player.correctCount,
      rank: myRank,
      rankDelta: player.rankDelta || 0,
      aheadNickname: aheadPlayer ? aheadPlayer.nickname : null,
      pointsBehindAhead: aheadPlayer
        ? Math.max(0, aheadPlayer.score - player.score)
        : 0,
      submittedOption: currentSubmission ? currentSubmission.optionIndex : null,
      submittedTimeMs: currentSubmission ? currentSubmission.timeMs : null,
      lastResult: player.lastResult || null,
    },
    top3:
      room.status === 'podium'
        ? sorted.slice(0, 3).map((p, idx) => ({
            rank: idx + 1,
            id: p.id,
            nickname: p.nickname,
            avatar: p.avatar,
            score: p.score,
          }))
        : [],
  };
}

function broadcastRoomState(room) {
  // Send to host
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('host:room_state', buildHostState(room));
  }
  // Send personalized state to every non-bot player
  for (const player of room.players.values()) {
    if (!player.isBot && player.socketId) {
      io.to(player.socketId).emit(
        'player:room_state',
        buildPlayerState(room, player)
      );
    }
  }
}

function scheduleBotAnswers(room) {
  const qIndex = room.currentQuestionIndex;
  const q = room.questions[qIndex];
  if (!q) return;

  const timeLimitMs = (q.timeLimit || 20) * 1000;

  for (const player of room.players.values()) {
    if (!player.isBot) continue;
    // Random response delay between 1.4s and 78% of time limit
    const minDelay = 1400;
    const maxDelay = Math.max(2500, Math.floor(timeLimitMs * 0.78));
    const delay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));

    const timer = setTimeout(() => {
      if (
        room.status !== 'question' ||
        room.currentQuestionIndex !== qIndex ||
        player.answers[qIndex]
      ) {
        return;
      }
      // ~70% chance bot picks a correct option, 30% random wrong option
      const isSmartHit = Math.random() < 0.7;
      let chosenIndex = 0;
      if (isSmartHit && q.correctIndices.length > 0) {
        chosenIndex =
          q.correctIndices[Math.floor(Math.random() * q.correctIndices.length)];
      } else {
        const wrongIndices = q.options
          .map((_, idx) => idx)
          .filter((idx) => !q.correctIndices.includes(idx));
        chosenIndex =
          wrongIndices.length > 0
            ? wrongIndices[Math.floor(Math.random() * wrongIndices.length)]
            : 0;
      }

      recordPlayerAnswer(room, player, chosenIndex);
    }, delay);

    room.botTimers.push(timer);
  }
}

function startQuestionCountdown(room, questionIndex) {
  clearRoomTimers(room);
  room.currentQuestionIndex = questionIndex;
  room.status = 'countdown';
  const countdownMs = 3200;
  room.countdownEndsAt = Date.now() + countdownMs;

  // Clear lastResult per player before new question
  for (const p of room.players.values()) {
    p.lastResult = null;
    p.lastPointsEarned = 0;
  }

  broadcastRoomState(room);

  room.phaseTimer = setTimeout(() => {
    startActiveQuestion(room);
  }, countdownMs);
}

function startActiveQuestion(room) {
  clearRoomTimers(room);
  const q = room.questions[room.currentQuestionIndex];
  if (!q) {
    finalizeGameToPodium(room);
    return;
  }

  room.status = 'question';
  const durationMs = (q.timeLimit || 20) * 1000;
  room.questionStartedAt = Date.now();
  room.questionEndsAt = room.questionStartedAt + durationMs;

  broadcastRoomState(room);
  scheduleBotAnswers(room);

  room.phaseTimer = setTimeout(() => {
    finishCurrentQuestion(room);
  }, durationMs);
}

function finishCurrentQuestion(room) {
  if (room.status !== 'question') return;
  clearRoomTimers(room);

  const qIndex = room.currentQuestionIndex;
  const q = room.questions[qIndex];
  const optionCounts = q.options.map(() => 0);

  // Capture previous ranks
  const prevSorted = getSortedPlayers(room);
  const prevRankMap = new Map();
  prevSorted.forEach((p, idx) => prevRankMap.set(p.id, idx + 1));

  let answeredCount = 0;

  for (const player of room.players.values()) {
    const sub = player.answers[qIndex];
    if (sub && typeof sub.optionIndex === 'number') {
      answeredCount++;
      if (optionCounts[sub.optionIndex] !== undefined) {
        optionCounts[sub.optionIndex]++;
      }
    }

    const isCorrect = Boolean(
      sub && q.correctIndices.includes(sub.optionIndex)
    );
    let basePoints = 0;
    let streakBonus = 0;

    if (isCorrect) {
      player.streak += 1;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
      player.correctCount += 1;
      player.totalResponseMs = (player.totalResponseMs || 0) + sub.timeMs;

      const maxPts = 1000 * (q.pointsMultiplier ?? 1);
      if (maxPts > 0) {
        const elapsedSec = Math.max(0, sub.timeMs / 1000);
        const timeLimitSec = q.timeLimit || 20;
        const ratio = Math.min(1, elapsedSec / timeLimitSec);
        basePoints =
          elapsedSec <= 0.5
            ? maxPts
            : Math.round((1 - ratio / 2) * maxPts);
        streakBonus =
          player.streak >= 4
            ? 300
            : player.streak === 3
            ? 200
            : player.streak === 2
            ? 100
            : 0;
      }
    } else {
      player.streak = 0;
    }

    const totalEarned = basePoints + streakBonus;
    player.score += totalEarned;
    player.lastPointsEarned = totalEarned;
    player.lastResult = {
      questionIndex: qIndex,
      answered: Boolean(sub),
      chosenOption: sub ? sub.optionIndex : null,
      isCorrect,
      basePoints,
      streakBonus,
      pointsEarned: totalEarned,
      correctIndices: q.correctIndices,
      explanation: q.explanation || '',
    };
  }

  // Recompute new ranks & deltas
  const newSorted = getSortedPlayers(room);
  newSorted.forEach((p, idx) => {
    const newRank = idx + 1;
    const oldRank = prevRankMap.get(p.id) || newRank;
    p.rank = newRank;
    p.rankDelta = oldRank - newRank;
  });

  room.lastOptionCounts = optionCounts;
  room.lastAnsweredCount = answeredCount;
  room.status = 'reveal';

  broadcastRoomState(room);

  if (room.settings.autoAdvance) {
    room.phaseTimer = setTimeout(() => {
      advanceFromReveal(room);
    }, 6000);
  }
}

function advanceFromReveal(room) {
  clearRoomTimers(room);
  const isLast = room.currentQuestionIndex >= room.questions.length - 1;
  if (isLast) {
    finalizeGameToPodium(room);
  } else {
    room.status = 'leaderboard';
    broadcastRoomState(room);
    if (room.settings.autoAdvance) {
      room.phaseTimer = setTimeout(() => {
        startQuestionCountdown(room, room.currentQuestionIndex + 1);
      }, 5000);
    }
  }
}

function finalizeGameToPodium(room) {
  clearRoomTimers(room);
  room.status = 'podium';

  // Save session report to history.json
  const sorted = getSortedPlayers(room);
  const totalQ = room.questions.length;
  const report = {
    id: `match-${Date.now()}-${room.pin}`,
    pin: room.pin,
    quizId: room.quiz.id,
    quizTitle: room.quiz.title,
    category: room.quiz.category,
    playedAt: new Date().toISOString(),
    totalQuestions: totalQ,
    playerCount: sorted.length,
    standings: sorted.map((p, idx) => ({
      rank: idx + 1,
      nickname: p.nickname,
      avatar: p.avatar,
      score: p.score,
      correctCount: p.correctCount,
      totalQuestions: totalQ,
      accuracy:
        totalQ > 0 ? Math.round((p.correctCount / totalQ) * 100) : 0,
      bestStreak: p.bestStreak,
      isBot: p.isBot,
    })),
  };

  const history = readJsonSafe(HISTORY_FILE, []);
  history.unshift(report);
  writeJsonSafe(HISTORY_FILE, history.slice(0, 100));

  broadcastRoomState(room);
}

function recordPlayerAnswer(room, player, optionIndex) {
  const qIndex = room.currentQuestionIndex;
  const q = room.questions[qIndex];
  if (!q || room.status !== 'question') return false;
  if (player.answers[qIndex]) return false;
  if (optionIndex < 0 || optionIndex >= q.options.length) return false;

  const timeMs = Math.max(50, Date.now() - room.questionStartedAt);
  player.answers[qIndex] = {
    optionIndex,
    timeMs,
  };

  // Notify player immediately of lock-in
  if (!player.isBot && player.socketId) {
    io.to(player.socketId).emit('player:room_state', buildPlayerState(room, player));
  }

  // Update host live answer count
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('host:room_state', buildHostState(room));
  }

  // Check if all active players + bots have answered
  const activePlayers = Array.from(room.players.values()).filter(
    (p) => p.connected || p.isBot
  );
  const allAnswered =
    activePlayers.length > 0 &&
    activePlayers.every((p) => Boolean(p.answers[qIndex]));

  if (allAnswered) {
    clearRoomTimers(room);
    room.phaseTimer = setTimeout(() => {
      finishCurrentQuestion(room);
    }, 450);
  }

  return true;
}

// ==========================================
// REST API ENDPOINTS
// ==========================================
app.get('/api/quizzes', (req, res) => {
  const quizzes = readJsonSafe(QUIZZES_FILE, []);
  res.json(quizzes);
});

app.post('/api/quizzes', (req, res) => {
  const quizzes = readJsonSafe(QUIZZES_FILE, []);
  const body = req.body || {};
  if (!body.title || !Array.isArray(body.questions) || body.questions.length === 0) {
    return res.status(400).json({ error: 'Vui lòng nhập tiêu đề và ít nhất 1 câu hỏi.' });
  }

  const newQuiz = {
    id: `quiz-${Date.now()}`,
    title: String(body.title).trim(),
    description: String(body.description || '').trim(),
    category: String(body.category || 'Đại cương').trim(),
    coverEmoji: body.coverEmoji || '🎯',
    coverGradient: body.coverGradient || 'from-violet-600 via-purple-600 to-indigo-700',
    createdAt: new Date().toISOString(),
    playCount: 0,
    questions: body.questions.map((q, idx) => ({
      id: q.id || `q-${Date.now()}-${idx}`,
      type: q.type === 'true_false' ? 'true_false' : 'multiple_choice',
      question: String(q.question || '').trim(),
      codeSnippet: String(q.codeSnippet || '').trim(),
      options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : ['Đáp án A', 'Đáp án B'],
      correctIndices: Array.isArray(q.correctIndices) && q.correctIndices.length > 0 ? q.correctIndices : [0],
      timeLimit: Number(q.timeLimit) || 20,
      pointsMultiplier: Number(q.pointsMultiplier ?? 1),
      explanation: String(q.explanation || '').trim(),
    })),
  };

  quizzes.unshift(newQuiz);
  writeJsonSafe(QUIZZES_FILE, quizzes);
  res.status(201).json(newQuiz);
});

app.put('/api/quizzes/:id', (req, res) => {
  const quizzes = readJsonSafe(QUIZZES_FILE, []);
  const idx = quizzes.findIndex((q) => q.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Không tìm thấy bộ câu hỏi.' });
  }

  const body = req.body || {};
  const existing = quizzes[idx];
  const updated = {
    ...existing,
    title: body.title ? String(body.title).trim() : existing.title,
    description: body.description !== undefined ? String(body.description).trim() : existing.description,
    category: body.category ? String(body.category).trim() : existing.category,
    coverEmoji: body.coverEmoji || existing.coverEmoji,
    coverGradient: body.coverGradient || existing.coverGradient,
    questions: Array.isArray(body.questions)
      ? body.questions.map((q, qIdx) => ({
          id: q.id || `q-${Date.now()}-${qIdx}`,
          type: q.type === 'true_false' ? 'true_false' : 'multiple_choice',
          question: String(q.question || '').trim(),
          codeSnippet: String(q.codeSnippet || '').trim(),
          options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : ['Đáp án A', 'Đáp án B'],
          correctIndices:
            Array.isArray(q.correctIndices) && q.correctIndices.length > 0
              ? q.correctIndices
              : [0],
          timeLimit: Number(q.timeLimit) || 20,
          pointsMultiplier: Number(q.pointsMultiplier ?? 1),
          explanation: String(q.explanation || '').trim(),
        }))
      : existing.questions,
  };

  quizzes[idx] = updated;
  writeJsonSafe(QUIZZES_FILE, quizzes);
  res.json(updated);
});

app.post('/api/quizzes/:id/duplicate', (req, res) => {
  const quizzes = readJsonSafe(QUIZZES_FILE, []);
  const source = quizzes.find((q) => q.id === req.params.id);
  if (!source) {
    return res.status(404).json({ error: 'Không tìm thấy bộ câu hỏi.' });
  }
  const copy = {
    ...JSON.parse(JSON.stringify(source)),
    id: `quiz-${Date.now()}`,
    title: `${source.title} (Bản sao)`,
    createdAt: new Date().toISOString(),
    playCount: 0,
  };
  quizzes.unshift(copy);
  writeJsonSafe(QUIZZES_FILE, quizzes);
  res.status(201).json(copy);
});

app.delete('/api/quizzes/:id', (req, res) => {
  const quizzes = readJsonSafe(QUIZZES_FILE, []);
  const filtered = quizzes.filter((q) => q.id !== req.params.id);
  writeJsonSafe(QUIZZES_FILE, filtered);
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => {
  const history = readJsonSafe(HISTORY_FILE, []);
  res.json(history);
});

app.delete('/api/history/:id', (req, res) => {
  const history = readJsonSafe(HISTORY_FILE, []);
  const filtered = history.filter((h) => h.id !== req.params.id);
  writeJsonSafe(HISTORY_FILE, filtered);
  res.json({ ok: true });
});

app.get('/api/active-rooms', (req, res) => {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status !== 'podium') {
      list.push({
        pin: room.pin,
        quizTitle: room.quiz.title,
        coverEmoji: room.quiz.coverEmoji,
        status: room.status,
        playerCount: room.players.size,
      });
    }
  }
  res.json(list);
});

app.post('/api/qr', async (req, res) => {
  try {
    const text = String(req.body?.text || '');
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const dataUrl = await QRCode.toDataURL(text, {
      width: 280,
      margin: 1,
      color: {
        dark: '#1e1b4b',
        light: '#ffffff',
      },
    });
    res.json({ dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ==========================================
// SOCKET.IO HANDLERS
// ==========================================
io.on('connection', (socket) => {
  // --- HOST CREATES ROOM ---
  socket.on('host:create_room', ({ quizId, settings }, cb) => {
    const quizzes = readJsonSafe(QUIZZES_FILE, []);
    const quiz = quizzes.find((q) => q.id === quizId);
    if (!quiz) {
      return cb?.({ ok: false, error: 'Không tìm thấy bộ câu hỏi này.' });
    }

    const pin = generatePin();
    const hostToken = crypto.randomBytes(16).toString('hex');
    const mergedSettings = {
      shuffleQuestions: Boolean(settings?.shuffleQuestions),
      shuffleOptions: Boolean(settings?.shuffleOptions),
      showTextOnDevices:
        settings?.showTextOnDevices !== undefined
          ? Boolean(settings.showTextOnDevices)
          : true,
      autoAdvance: Boolean(settings?.autoAdvance),
    };

    const room = {
      pin,
      hostToken,
      hostSocketId: socket.id,
      quiz,
      questions: prepareQuestions(quiz.questions, mergedSettings),
      settings: mergedSettings,
      status: 'lobby',
      currentQuestionIndex: -1,
      countdownEndsAt: null,
      questionStartedAt: null,
      questionEndsAt: null,
      lastOptionCounts: [],
      lastAnsweredCount: 0,
      players: new Map(),
      phaseTimer: null,
      botTimers: [],
      createdAt: Date.now(),
    };

    rooms.set(pin, room);
    socket.join(`room:${pin}`);

    cb?.({
      ok: true,
      pin,
      hostToken,
      room: buildHostState(room),
    });
  });

  // --- HOST REJOINS ROOM ---
  socket.on('host:rejoin_room', ({ pin, hostToken }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) {
      return cb?.({ ok: false, error: 'Phòng thi đã đóng hoặc không hợp lệ.' });
    }
    room.hostSocketId = socket.id;
    socket.join(`room:${room.pin}`);
    cb?.({ ok: true, room: buildHostState(room) });
  });

  // --- HOST UPDATES SETTINGS IN LOBBY ---
  socket.on('host:update_settings', ({ pin, hostToken, settings }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) {
      return cb?.({ ok: false, error: 'Không có quyền điều khiển phòng.' });
    }
    room.settings = {
      ...room.settings,
      ...settings,
    };
    if (room.status === 'lobby') {
      room.questions = prepareQuestions(room.quiz.questions, room.settings);
    }
    broadcastRoomState(room);
    cb?.({ ok: true, room: buildHostState(room) });
  });

  // --- HOST ADDS SIMULATED BOT STUDENTS ---
  socket.on('host:add_bots', ({ pin, hostToken, count = 3 }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) {
      return cb?.({ ok: false, error: 'Không tìm thấy phòng.' });
    }

    const existingNames = new Set(
      Array.from(room.players.values()).map((p) => p.nickname)
    );
    const available = BOT_PROFILES.filter((b) => !existingNames.has(b.nickname));
    const toAdd = available.slice(0, Math.min(count, 6));

    toAdd.forEach((profile) => {
      const id = `bot-${crypto.randomBytes(4).toString('hex')}`;
      room.players.set(id, {
        id,
        playerToken: id,
        socketId: null,
        nickname: profile.nickname,
        avatar: profile.avatar,
        score: 0,
        streak: 0,
        bestStreak: 0,
        correctCount: 0,
        totalResponseMs: 0,
        answers: {},
        isBot: true,
        connected: true,
        rank: room.players.size + 1,
        rankDelta: 0,
      });
    });

    broadcastRoomState(room);
    cb?.({ ok: true, added: toAdd.length });
  });

  // --- HOST KICKS PLAYER ---
  socket.on('host:kick_player', ({ pin, hostToken, playerId }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) {
      return cb?.({ ok: false });
    }
    const target = room.players.get(playerId);
    if (target) {
      if (target.socketId) {
        io.to(target.socketId).emit('player:kicked', {
          reason: 'Giảng viên đã mời bạn rời khỏi phòng chờ.',
        });
      }
      room.players.delete(playerId);
      broadcastRoomState(room);
    }
    cb?.({ ok: true });
  });

  // --- HOST STARTS GAME ---
  socket.on('host:start_game', ({ pin, hostToken }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) {
      return cb?.({ ok: false, error: 'Không tìm thấy phòng.' });
    }
    if (room.players.size === 0) {
      return cb?.({
        ok: false,
        error: 'Cần ít nhất 1 sinh viên tham gia để bắt đầu thi đấu!',
      });
    }
    if (room.status !== 'lobby') {
      return cb?.({ ok: false, error: 'Trận đấu đã bắt đầu.' });
    }

    // Increment quiz playCount
    const quizzes = readJsonSafe(QUIZZES_FILE, []);
    const qIdx = quizzes.findIndex((q) => q.id === room.quiz.id);
    if (qIdx !== -1) {
      quizzes[qIdx].playCount = (quizzes[qIdx].playCount || 0) + 1;
      writeJsonSafe(QUIZZES_FILE, quizzes);
    }

    startQuestionCountdown(room, 0);
    cb?.({ ok: true });
  });

  // --- HOST ENDS QUESTION EARLY ---
  socket.on('host:end_question_early', ({ pin, hostToken }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) return cb?.({ ok: false });
    if (room.status === 'question') {
      finishCurrentQuestion(room);
    }
    cb?.({ ok: true });
  });

  // --- HOST ADVANCES TO NEXT STEP ---
  socket.on('host:next_step', ({ pin, hostToken }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) return cb?.({ ok: false });

    if (room.status === 'reveal') {
      advanceFromReveal(room);
    } else if (room.status === 'leaderboard') {
      startQuestionCountdown(room, room.currentQuestionIndex + 1);
    }
    cb?.({ ok: true });
  });

  // --- HOST PLAY AGAIN WITH SAME PLAYERS ---
  socket.on('host:restart_lobby', ({ pin, hostToken }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) return cb?.({ ok: false });

    clearRoomTimers(room);
    room.status = 'lobby';
    room.currentQuestionIndex = -1;
    room.questions = prepareQuestions(room.quiz.questions, room.settings);
    room.lastOptionCounts = [];
    room.lastAnsweredCount = 0;

    for (const p of room.players.values()) {
      p.score = 0;
      p.streak = 0;
      p.bestStreak = 0;
      p.correctCount = 0;
      p.totalResponseMs = 0;
      p.answers = {};
      p.rank = 1;
      p.rankDelta = 0;
      p.lastResult = null;
      p.lastPointsEarned = 0;
    }

    broadcastRoomState(room);
    cb?.({ ok: true });
  });

  // --- HOST CLOSES ROOM ---
  socket.on('host:close_room', ({ pin, hostToken }, cb) => {
    const room = rooms.get(String(pin || '').trim());
    if (!room || room.hostToken !== hostToken) return cb?.({ ok: false });

    clearRoomTimers(room);
    for (const p of room.players.values()) {
      if (!p.isBot && p.socketId) {
        io.to(p.socketId).emit('room:closed', {
          message: 'Giảng viên đã kết thúc phòng thi.',
        });
      }
    }
    rooms.delete(room.pin);
    cb?.({ ok: true });
  });

  // --- STUDENT CHECKS PIN ---
  socket.on('player:check_pin', ({ pin }, cb) => {
    const cleanPin = String(pin || '').replace(/\s+/g, '');
    const room = rooms.get(cleanPin);
    if (!room) {
      return cb?.({
        ok: false,
        error: 'Mã PIN không tồn tại hoặc phòng thi đã kết thúc!',
      });
    }
    if (room.status === 'podium') {
      return cb?.({
        ok: false,
        error: 'Trận đấu này đã kết thúc. Hãy xin mã PIN mới từ giảng viên!',
      });
    }
    cb?.({
      ok: true,
      pin: room.pin,
      quizTitle: room.quiz.title,
      coverEmoji: room.quiz.coverEmoji,
      status: room.status,
      playerCount: room.players.size,
    });
  });

  // --- STUDENT JOINS OR RECONNECTS ---
  socket.on('player:join', ({ pin, nickname, avatar, playerToken }, cb) => {
    const cleanPin = String(pin || '').replace(/\s+/g, '');
    const room = rooms.get(cleanPin);
    if (!room) {
      return cb?.({
        ok: false,
        error: 'Mã PIN không tồn tại hoặc phòng thi đã đóng.',
      });
    }

    // Check reconnect by playerToken
    if (playerToken) {
      for (const existing of room.players.values()) {
        if (existing.playerToken === playerToken) {
          existing.socketId = socket.id;
          existing.connected = true;
          socket.join(`room:${room.pin}`);
          broadcastRoomState(room);
          return cb?.({
            ok: true,
            reconnected: true,
            playerToken: existing.playerToken,
            state: buildPlayerState(room, existing),
          });
        }
      }
    }

    if (room.status === 'podium') {
      return cb?.({
        ok: false,
        error: 'Trận đấu đã kết thúc.',
      });
    }

    const cleanName = String(nickname || '').trim().slice(0, 28);
    if (!cleanName) {
      return cb?.({
        ok: false,
        error: 'Vui lòng nhập tên hoặc mã sinh viên của bạn!',
      });
    }

    // Check duplicate nickname
    const duplicate = Array.from(room.players.values()).some(
      (p) => p.nickname.toLowerCase() === cleanName.toLowerCase()
    );
    if (duplicate) {
      return cb?.({
        ok: false,
        error: `Tên "${cleanName}" đã có bạn dùng trong phòng. Hãy thêm MSSV hoặc ký tự khác nhé!`,
      });
    }

    const id = `p-${crypto.randomBytes(6).toString('hex')}`;
    const token = crypto.randomBytes(16).toString('hex');
    const newPlayer = {
      id,
      playerToken: token,
      socketId: socket.id,
      nickname: cleanName,
      avatar: avatar || '🎓',
      score: 0,
      streak: 0,
      bestStreak: 0,
      correctCount: 0,
      totalResponseMs: 0,
      answers: {},
      isBot: false,
      connected: true,
      rank: room.players.size + 1,
      rankDelta: 0,
      lastResult: null,
      lastPointsEarned: 0,
    };

    room.players.set(id, newPlayer);
    socket.join(`room:${room.pin}`);
    broadcastRoomState(room);

    // Notify host with sound trigger
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('host:player_joined', {
        id: newPlayer.id,
        nickname: newPlayer.nickname,
        avatar: newPlayer.avatar,
      });
    }

    cb?.({
      ok: true,
      playerToken: token,
      state: buildPlayerState(room, newPlayer),
    });
  });

  // --- STUDENT SUBMITS ANSWER ---
  socket.on('player:submit_answer', ({ pin, playerToken, optionIndex }, cb) => {
    const cleanPin = String(pin || '').replace(/\s+/g, '');
    const room = rooms.get(cleanPin);
    if (!room) {
      return cb?.({ ok: false, error: 'Phòng không tồn tại.' });
    }
    const player = Array.from(room.players.values()).find(
      (p) => p.playerToken === playerToken
    );
    if (!player) {
      return cb?.({ ok: false, error: 'Không tìm thấy thông tin người chơi.' });
    }

    const recorded = recordPlayerAnswer(room, player, Number(optionIndex));
    cb?.({ ok: recorded });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      for (const player of room.players.values()) {
        if (player.socketId === socket.id) {
          player.connected = false;
          if (room.hostSocketId) {
            io.to(room.hostSocketId).emit('host:room_state', buildHostState(room));
          }
        }
      }
    }
  });
});

// Periodic cleanup of stale rooms older than 6 hours
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [pin, room] of rooms.entries()) {
    if (room.createdAt < cutoff) {
      clearRoomTimers(room);
      rooms.delete(pin);
    }
  }
}, 30 * 60 * 1000);

// Serve flat frontend assets safely
app.get('/app.js', (req, res) => res.sendFile(path.join(ROOT_DIR, 'app.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(ROOT_DIR, 'style.css')));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return res.status(404).end();
  }
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`QuizArena server listening on http://0.0.0.0:${PORT}`);
});
