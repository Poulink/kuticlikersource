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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = new Map();
const players = new Map();
const playerLastClicks = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const roomIntervals = new Map();

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
          megaClick: 0,
          energyFactory: false
        },
        gameStarted: false,
        cursors: [],
        factoryEvent: null
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
      
      // Если активен ивент с заводом - особые правила
      if (room.factoryEvent && room.factoryEvent.active) {
        basePoints = 0; // Во время ивента клики не дают очков
      } else {
        // Обычные улучшения работают только вне ивента
        const isCritical = Math.random() * 100 < room.upgrades.criticalChance;
        if (isCritical) {
          basePoints *= 3;
          socket.emit('criticalHit', { points: basePoints });
        }
        
        const isGolden = Math.random() * 100 < room.upgrades.goldenClicks;
        if (isGolden) {
          basePoints *= 5;
          socket.emit('goldenClick', { points: basePoints });
        }
        
        if (room.upgrades.megaClick > 0) {
          basePoints += room.upgrades.megaClick * 10;
        }
      }
      
      room.score += basePoints;
      
      console.log(`Клик в комнате ${player.roomId}, очки: ${room.score}`);
      
      io.to(player.roomId).emit('scoreUpdate', {
        score: room.score,
        clicker: socket.id,
        points: basePoints,
        isCritical: basePoints > 1 && !room.factoryEvent?.active,
        isGolden: basePoints > 3 && !room.factoryEvent?.active
      });
    } catch (error) {
      console.error('Ошибка клика:', error);
    }
  });

  socket.on('buyUpgrade', (upgradeType) => {
    try {
      const player = players.get(socket.id);
      if (!player) return;
      
      const room = rooms.get(player.roomId);
      if (!room || !room.gameStarted) return;
      
      // Если активен ивент с заводом - особые правила
      if (room.factoryEvent && room.factoryEvent.active) {
        if (upgradeType === 'holdDefense') {
          const cost = 100;
          if (room.score >= cost) {
            room.score -= cost;
            room.factoryEvent.defenseSpent += cost;
            
            // Проверяем потратили ли все 20000
            if (room.factoryEvent.defenseSpent >= 20000) {
              room.factoryEvent.success = true;
              endFactoryEvent(room, true);
            }
            
            io.to(player.roomId).emit('upgradeBought', {
              upgradeType,
              upgrades: room.upgrades,
              score: room.score,
              defenseSpent: room.factoryEvent.defenseSpent
            });
          }
        }
        return;
      }
      
      // Обычные улучшения
      const upgradeCosts = {
        autoClicker: 50 * (room.upgrades.autoClicker + 1),
        clickMultiplier: 100 * room.upgrades.clickMultiplier,
        bonusPerSecond: 200 * (room.upgrades.bonusPerSecond + 1),
        criticalChance: 300 * (room.upgrades.criticalChance + 1),
        goldenClicks: 500 * (room.upgrades.goldenClicks + 1),
        threeDMaker: 1000,
        rainbowMode: 1500,
        megaClick: 800 * (room.upgrades.megaClick + 1),
        energyFactory: 3000
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
      
      if (upgradeType === 'energyFactory' && room.upgrades.energyFactory) {
        socket.emit('error', 'Энергозавод уже куплен!');
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
            room.upgrades.criticalChance += 5;
            break;
          case 'goldenClicks':
            room.upgrades.goldenClicks += 2;
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
          case 'energyFactory':
            room.upgrades.energyFactory = true;
            // Добавляем кнопку открытия станции
            socket.emit('factoryBuilt');
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

  // Обработка открытия станции энергозавода
  socket.on('openFactoryStation', () => {
    try {
      const player = players.get(socket.id);
      if (!player) return;
      
      const room = rooms.get(player.roomId);
      if (!room || !room.gameStarted) return;
      
      if (!room.upgrades.energyFactory) {
        socket.emit('error', 'У вас нет энергозавода!');
        return;
      }
      
      // Запускаем ивент с энергозаводом
      startFactoryEvent(room);
      
    } catch (error) {
      console.error('Ошибка открытия станции:', error);
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

// Запуск ивента с энергозаводом
function startFactoryEvent(room) {
  room.factoryEvent = {
    active: true,
    startTime: Date.now(),
    defenseSpent: 0,
    success: false
  };
  
  // Устанавливаем счетчик на 20000
  room.score = 20000;
  
  io.to(room.id).emit('factoryEventStarted', {
    timeLeft: 20,
    defenseSpent: 0
  });
  
  // Таймер ивента (20 секунд)
  const eventInterval = setInterval(() => {
    if (!rooms.has(room.id)) {
      clearInterval(eventInterval);
      return;
    }
    
    const currentRoom = rooms.get(room.id);
    if (!currentRoom || !currentRoom.factoryEvent?.active) {
      clearInterval(eventInterval);
      return;
    }
    
    const timePassed = Date.now() - currentRoom.factoryEvent.startTime;
    const timeLeft = Math.max(0, 20 - Math.floor(timePassed / 1000));
    
    if (timeLeft <= 0) {
      // Время вышло - неудача
      clearInterval(eventInterval);
      endFactoryEvent(currentRoom, false);
    } else {
      io.to(room.id).emit('factoryEventUpdate', {
        timeLeft: timeLeft,
        defenseSpent: currentRoom.factoryEvent.defenseSpent
      });
    }
  }, 1000);
}

// Завершение ивента с энергозаводом
function endFactoryEvent(room, success) {
  room.factoryEvent.active = false;
  
  if (success) {
    // Успех - возвращаем обычные улучшения, но завод пропадает
    room.upgrades.energyFactory = false;
    room.score = 0; // Обнуляем счет
    
    io.to(room.id).emit('factoryEventSuccess');
  } else {
    // Неудача - забираем завод и возвращаем обычные улучшения
    room.upgrades.energyFactory = false;
    room.score = 0; // Обнуляем счет
    
    io.to(room.id).emit('factoryEventFailed');
  }
  
  // Удаляем ивент
  room.factoryEvent = null;
}

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
    if (!currentRoom || !currentRoom.gameStarted) return;
    
    // Если активен ивент с заводом - автокликеры не работают
    if (!currentRoom.factoryEvent?.active) {
      if (currentRoom.upgrades.autoClicker > 0) {
        currentRoom.score += currentRoom.upgrades.autoClicker * currentRoom.upgrades.clickMultiplier;
      }
      
      if (currentRoom.upgrades.bonusPerSecond > 0) {
        currentRoom.score += currentRoom.upgrades.bonusPerSecond * 5;
      }
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
