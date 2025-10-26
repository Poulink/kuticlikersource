const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Хранилище данных игры
const rooms = new Map();
const players = new Map();

// Хранилище последних кликов для античита
const playerLastClicks = new Map();

// Генерация ID комнаты
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Интервалы для комнат
const roomIntervals = new Map();

// Античит система - 1 клик в 1ms = читер
function checkAntiCheat(playerId) {
  const now = Date.now();
  const lastClick = playerLastClicks.get(playerId);
  
  if (lastClick) {
    const timeDiff = now - lastClick;
    if (timeDiff < 1) {
      return false;
    }
  }
  
  playerLastClicks.set(playerId, now);
  return true;
}

// Кик игрока за читерство
function kickPlayer(socket, reason) {
  const player = players.get(socket.id);
  if (player) {
    const room = rooms.get(player.roomId);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      room.cursors = room.cursors.filter(c => !c.id.includes(`auto-${socket.id}`));
      
      io.to(player.roomId).emit('roomUpdate', room);
      io.to(player.roomId).emit('cursorsUpdate', room.cursors);
      io.to(player.roomId).emit('playerKicked', { playerId: socket.id, reason: reason });
    }
    players.delete(socket.id);
    playerLastClicks.delete(socket.id);
  }
  
  socket.emit('cheatDetected', reason);
  setTimeout(() => {
    socket.disconnect();
  }, 3000);
}

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  // Создание комнаты
  socket.on('createRoom', (roomSize) => {
    try {
      const roomId = generateRoomId();
      const room = {
        id: roomId,
        size: parseInt(roomSize),
        players: [],
        score: 0,
        upgrades: {
          autoClicker: 0,
          clickMultiplier: 1,
          bonusPerSecond: 0,
          criticalChance: 0,
          goldenClicks: 0,
          threeDMaker: false,
          rainbowMode: false,
          megaClick: 0
        },
        gameStarted: false,
        cursors: []
      };
      
      rooms.set(roomId, room);
      socket.join(roomId);
      
      const playerInfo = {
        id: socket.id,
        name: `Игрок1`,
        roomId: roomId
      };
      
      players.set(socket.id, playerInfo);
      room.players.push(playerInfo);
      
      console.log(`Комната создана: ${roomId}, игроков: ${room.players.length}`);
      
      socket.emit('roomCreated', { roomId: roomId });
      io.to(roomId).emit('roomUpdate', room);
    } catch (error) {
      console.error('Ошибка создания комнаты:', error);
      socket.emit('error', 'Ошибка создания комнаты');
    }
  });

  // Присоединение к комнате
  socket.on('joinRoom', (roomId) => {
    try {
      const cleanRoomId = roomId.trim().toUpperCase();
      console.log('Попытка присоединения к комнате:', cleanRoomId);
      
      const room = rooms.get(cleanRoomId);
      if (!room) {
        socket.emit('error', 'Комната не найдена');
        return;
      }
      
      if (room.gameStarted) {
        socket.emit('error', 'Игра уже началась');
        return;
      }
      
      if (room.players.length >= room.size) {
        socket.emit('error', 'Комната заполнена');
        return;
      }
      
      socket.join(cleanRoomId);
      
      const playerInfo = {
        id: socket.id,
        name: `Игрок${room.players.length + 1}`,
        roomId: cleanRoomId
      };
      
      players.set(socket.id, playerInfo);
      room.players.push(playerInfo);
      
      console.log(`Игрок присоединился: ${cleanRoomId}, теперь игроков: ${room.players.length}`);
      
      io.to(cleanRoomId).emit('roomUpdate', room);
      
      if (room.players.length === room.size && !room.gameStarted) {
        room.gameStarted = true;
        startGame(cleanRoomId);
        io.to(cleanRoomId).emit('gameStarted');
      }
    } catch (error) {
      console.error('Ошибка присоединения:', error);
      socket.emit('error', 'Ошибка присоединения к комнате');
    }
  });

  // Обработка кликов с античитом
  socket.on('click', () => {
    try {
      if (!checkAntiCheat(socket.id)) {
        kickPlayer(socket, 'СЛИШКОМ БЫСТРЫЕ КЛИКИ! ИГРАЙ ЧЕСТНО! ИШАК!!');
        return;
      }
      
      const player = players.get(socket.id);
      if (!player) return;
      
      const room = rooms.get(player.roomId);
      if (!room || !room.gameStarted) return;
      
      let basePoints = 1 * room.upgrades.clickMultiplier;
      
      // Критический удар
      const isCritical = Math.random() * 100 < room.upgrades.criticalChance;
      if (isCritical) {
        basePoints *= 3;
        socket.emit('criticalHit', { points: basePoints });
      }
      
      // Золотые клики
      const isGolden = Math.random() * 100 < room.upgrades.goldenClicks;
      if (isGolden) {
        basePoints *= 5;
        socket.emit('goldenClick', { points: basePoints });
      }
      
      // Мега клик
      if (room.upgrades.megaClick > 0) {
        basePoints += room.upgrades.megaClick * 10;
      }
      
      room.score += basePoints;
      
      console.log(`Клик в комнате ${player.roomId}, очки: ${room.score}`);
      
      io.to(player.roomId).emit('scoreUpdate', {
        score: room.score,
        clicker: socket.id,
        points: basePoints,
        isCritical: isCritical,
        isGolden: isGolden
      });
    } catch (error) {
      console.error('Ошибка клика:', error);
    }
  });

  // Покупка улучшений
  socket.on('buyUpgrade', (upgradeType) => {
    try {
      const player = players.get(socket.id);
      if (!player) return;
      
      const room = rooms.get(player.roomId);
      if (!room || !room.gameStarted) return;
      
      const upgradeCosts = {
        autoClicker: 50 * (room.upgrades.autoClicker + 1),
        clickMultiplier: 100 * room.upgrades.clickMultiplier,
        bonusPerSecond: 200 * (room.upgrades.bonusPerSecond + 1),
        criticalChance: 300 * (room.upgrades.criticalChance + 1),
        goldenClicks: 500 * (room.upgrades.goldenClicks + 1),
        threeDMaker: 1000,
        rainbowMode: 1500,
        megaClick: 800 * (room.upgrades.megaClick + 1)
      };
      
      const cost = upgradeCosts[upgradeType];
      
      // Проверка для уникальных улучшений
      if (upgradeType === 'threeDMaker' && room.upgrades.threeDMaker) {
        socket.emit('error', '3D Maker уже куплен!');
        return;
      }
      
      if (upgradeType === 'rainbowMode' && room.upgrades.rainbowMode) {
        socket.emit('error', 'Rainbow Mode уже куплен!');
        return;
      }
      
      if (room.score >= cost) {
        room.score -= cost;
        
        switch (upgradeType) {
          case 'autoClicker':
            room.upgrades.autoClicker++;
            addAutoClickerCursor(room, socket.id);
            break;
          case 'clickMultiplier':
            room.upgrades.clickMultiplier++;
            break;
          case 'bonusPerSecond':
            room.upgrades.bonusPerSecond++;
            break;
          case 'criticalChance':
            room.upgrades.criticalChance += 5; // +5% за уровень
            break;
          case 'goldenClicks':
            room.upgrades.goldenClicks += 2; // +2% за уровень
            break;
          case 'threeDMaker':
            room.upgrades.threeDMaker = true;
            break;
          case 'rainbowMode':
            room.upgrades.rainbowMode = true;
            break;
          case 'megaClick':
            room.upgrades.megaClick++;
            break;
        }
        
        io.to(player.roomId).emit('upgradeBought', {
          upgradeType,
          upgrades: room.upgrades,
          score: room.score
        });
        
        if (upgradeType === 'autoClicker') {
          io.to(player.roomId).emit('cursorsUpdate', room.cursors);
        }
        
        // Специальные эффекты для уникальных улучшений
        if (upgradeType === 'threeDMaker') {
          io.to(player.roomId).emit('threeDActivated');
        }
        
        if (upgradeType === 'rainbowMode') {
          io.to(player.roomId).emit('rainbowActivated');
        }
      }
    } catch (error) {
      console.error('Ошибка покупки улучшения:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
    try {
      const player = players.get(socket.id);
      if (player) {
        const room = rooms.get(player.roomId);
        if (room) {
          room.players = room.players.filter(p => p.id !== socket.id);
          room.cursors = room.cursors.filter(c => !c.id.includes(`auto-${socket.id}`));
          
          console.log(`Игрок вышел из комнаты ${player.roomId}, осталось: ${room.players.length}`);
          
          io.to(player.roomId).emit('roomUpdate', room);
          io.to(player.roomId).emit('cursorsUpdate', room.cursors);
          
          if (room.players.length === 0) {
            const intervalId = roomIntervals.get(player.roomId);
            if (intervalId) {
              clearInterval(intervalId);
              roomIntervals.delete(player.roomId);
            }
            rooms.delete(player.roomId);
            console.log(`Комната ${player.roomId} удалена`);
          }
        }
        players.delete(socket.id);
        playerLastClicks.delete(socket.id);
      }
    } catch (error) {
      console.error('Ошибка при отключении:', error);
    }
  });
});

// Функция добавления курсора автокликера
function addAutoClickerCursor(room, playerId) {
  const autoCursorId = `auto-${playerId}-${Date.now()}`;
  
  const autoCursor = {
    id: autoCursorId,
    x: Math.random() * 80 + 10,
    y: Math.random() * 80 + 10,
    rotation: 0
  };
  
  room.cursors.push(autoCursor);
  
  const rotateInterval = setInterval(() => {
    if (!rooms.has(room.id)) {
      clearInterval(rotateInterval);
      return;
    }
    
    const currentRoom = rooms.get(room.id);
    if (!currentRoom) {
      clearInterval(rotateInterval);
      return;
    }
    
    const cursor = currentRoom.cursors.find(c => c.id === autoCursorId);
    if (cursor) {
      cursor.rotation = (cursor.rotation + 5) % 360;
      cursor.x = 50 + Math.cos(Date.now() / 1000 + cursor.id.length) * 30;
      cursor.y = 50 + Math.sin(Date.now() / 1000 + cursor.id.length) * 30;
    } else {
      clearInterval(rotateInterval);
    }
  }, 100);
}

// Функция автокликера
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  console.log(`Игра началась в комнате ${roomId}`);
  
  const gameInterval = setInterval(() => {
    if (!rooms.has(roomId)) {
      clearInterval(gameInterval);
      roomIntervals.delete(roomId);
      return;
    }
    
    const currentRoom = rooms.get(roomId);
    if (!currentRoom || !currentRoom.gameStarted) {
      clearInterval(gameInterval);
      roomIntervals.delete(roomId);
      return;
    }
    
    // Автоматические клики
    if (currentRoom.upgrades.autoClicker > 0) {
      currentRoom.score += currentRoom.upgrades.autoClicker * currentRoom.upgrades.clickMultiplier;
    }
    
    // Бонусы в секунду
    if (currentRoom.upgrades.bonusPerSecond > 0) {
      currentRoom.score += currentRoom.upgrades.bonusPerSecond * 5;
    }
    
    io.to(roomId).emit('autoUpdate', {
      score: currentRoom.score,
      upgrades: currentRoom.upgrades
    });
    
  }, 1000);
  
  roomIntervals.set(roomId, gameInterval);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Kuti Clicker сервер запущен на порту ${PORT}`);
  console.log(`📱 Откройте браузер и перейдите по адресу:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   или http://ваш-ip:${PORT} для других устройств`);
});