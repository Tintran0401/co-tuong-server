/*
  CỜ TƯỚNG ONLINE — Backend Server v2.1
  Node.js + Socket.IO
  Deploy: Railway.app
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json());

// ── State ──
const rooms = {};
const queue = { flash: null, normal: null, hidden: null };

// Leaderboard: lưu ELO thực tế của từng player theo mode
const leaderboard = { flash:[], normal:[], hidden:[] };

// ── HTTP Endpoints ──
app.get('/', (_, res) => res.send('🎭 Cờ Tướng Server v2.1 đang chạy ✅'));

app.get('/health', (_, res) => {
  res.header('Access-Control-Allow-Origin','*');
  res.json({
    status: 'ok',
    rooms: Object.keys(rooms).length,
    queues: { flash: !!queue.flash, normal: !!queue.normal, hidden: !!queue.hidden },
    uptime: Math.floor(process.uptime())
  });
});

app.get('/rooms', (_, res) => {
  res.header('Access-Control-Allow-Origin','*');
  const list = Object.values(rooms)
    .filter(r => r.players.length === 2 && !r.ended)
    .map(r => {
      // Tính thời gian hiện tại
      let rTime = r.rTime || r.baseTime || 600;
      let bTime = r.bTime || r.baseTime || 600;
      if (r.lastMoveTime) {
        const elapsed = Math.floor((Date.now() - r.lastMoveTime) / 1000);
        if (r.turn === 'r') rTime = Math.max(0, rTime - elapsed);
        else bTime = Math.max(0, bTime - elapsed);
      }
      return {
        id: r.id,
        mode: r.mode,
        players: r.players.map(p => p.name),
        moves: r.moves.length,
        spectators: r.spectators ? r.spectators.length : 0,
        rTime, bTime
      };
    });
  res.json(list);
});

app.get('/leaderboard', (_, res) => {
  res.header('Access-Control-Allow-Origin','*');
  res.json(leaderboard);
});

// ── Leaderboard helpers ──
function updateLeaderboard(name, mode, result, newElo) {
  const lb = leaderboard[mode];
  if (!lb) return;
  let entry = lb.find(e => e.name === name);
  if (!entry) {
    entry = { name, elo: newElo, w:0, l:0, d:0, games:0 };
    lb.push(entry);
  }
  entry.elo = newElo;
  entry.games++;
  if (result === 'win') entry.w++;
  else if (result === 'lose') entry.l++;
  else entry.d++;
  lb.sort((a,b) => b.elo - a.elo);
  if (lb.length > 50) lb.splice(50);
}

// ── Board helpers ──
function makeRoomId() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}

function mkBoard() {
  return [
    {t:'R',s:'b',r:0,c:0,id:0},{t:'N',s:'b',r:0,c:1,id:1},{t:'B',s:'b',r:0,c:2,id:2},
    {t:'A',s:'b',r:0,c:3,id:3},{t:'K',s:'b',r:0,c:4,id:4},{t:'A',s:'b',r:0,c:5,id:5},
    {t:'B',s:'b',r:0,c:6,id:6},{t:'N',s:'b',r:0,c:7,id:7},{t:'R',s:'b',r:0,c:8,id:8},
    {t:'C',s:'b',r:2,c:1,id:9},{t:'C',s:'b',r:2,c:7,id:10},
    {t:'P',s:'b',r:3,c:0,id:11},{t:'P',s:'b',r:3,c:2,id:12},{t:'P',s:'b',r:3,c:4,id:13},
    {t:'P',s:'b',r:3,c:6,id:14},{t:'P',s:'b',r:3,c:8,id:15},
    {t:'P',s:'r',r:6,c:0,id:16},{t:'P',s:'r',r:6,c:2,id:17},{t:'P',s:'r',r:6,c:4,id:18},
    {t:'P',s:'r',r:6,c:6,id:19},{t:'P',s:'r',r:6,c:8,id:20},
    {t:'C',s:'r',r:7,c:1,id:21},{t:'C',s:'r',r:7,c:7,id:22},
    {t:'R',s:'r',r:9,c:0,id:23},{t:'N',s:'r',r:9,c:1,id:24},{t:'B',s:'r',r:9,c:2,id:25},
    {t:'A',s:'r',r:9,c:3,id:26},{t:'K',s:'r',r:9,c:4,id:27},{t:'A',s:'r',r:9,c:5,id:28},
    {t:'B',s:'r',r:9,c:6,id:29},{t:'N',s:'r',r:9,c:7,id:30},{t:'R',s:'r',r:9,c:8,id:31}
  ];
}

function mkHiddenBoard() {
  const board = mkBoard();
  const posToType = {};
  mkBoard().forEach(p => { posToType[`${p.s}_${p.r}_${p.c}`] = p.t; });
  ['r','b'].forEach(side => {
    const pieces = board.filter(p => p.s === side && p.t !== 'K');
    const positions = pieces.map(p => ({ r: p.r, c: p.c }));
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    pieces.forEach((p, i) => {
      const np = positions[i];
      p.r = np.r; p.c = np.c;
      p.posType = posToType[`${side}_${np.r}_${np.c}`] || p.t;
      p.hidden = true; p.revealed = false;
    });
  });
  board.filter(p => p.t === 'K').forEach(p => {
    p.hidden = false; p.revealed = true; p.posType = null;
  });
  return board;
}

// ── Chess logic ──
function onBoard(r,c){return r>=0&&r<10&&c>=0&&c<9;}
function inPalace(r,c,s){return s==='r'?(r>=7&&r<=9&&c>=3&&c<=5):(r>=0&&r<=2&&c>=3&&c<=5);}
function getAt(board,r,c){return board.find(p=>p.r===r&&p.c===c)||null;}

function getRawMoves(p,board,isHiddenMode=false){
  const mv=[],{s,r,c}=p;
  const t=(p.hidden&&p.posType)?p.posType:p.t;
  const add=(nr,nc)=>{if(!onBoard(nr,nc))return;const tg=getAt(board,nr,nc);if(tg&&tg.s===s)return;mv.push([nr,nc]);};
  if(t==='K'){[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>{const nr=r+dr,nc=c+dc;if(inPalace(nr,nc,s))add(nr,nc);});}
  else if(t==='A'){[[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dr,dc])=>{
    const nr=r+dr,nc=c+dc;
    if(isHiddenMode&&!p.hidden)add(nr,nc);else if(inPalace(nr,nc,s))add(nr,nc);});}
  else if(t==='B'){[[2,2],[2,-2],[-2,2],[-2,-2]].forEach(([dr,dc])=>{
    const nr=r+dr,nc=c+dc;if(!onBoard(nr,nc))return;
    if(getAt(board,r+dr/2,c+dc/2))return;
    if(isHiddenMode&&!p.hidden){}
    else{if(s==='r'&&nr<5)return;if(s==='b'&&nr>4)return;}
    add(nr,nc);});}
  else if(t==='N'){[[1,2],[1,-2],[-1,2],[-1,-2],[2,1],[2,-1],[-2,1],[-2,-1]].forEach(([dr,dc])=>{
    const nr=r+dr,nc=c+dc;if(!onBoard(nr,nc))return;
    const blk=Math.abs(dr)===2?getAt(board,r+(dr>0?1:-1),c):getAt(board,r,c+(dc>0?1:-1));
    if(blk)return;add(nr,nc);});}
  else if(t==='R'){[[0,1],[0,-1],[1,0],[-1,0]].forEach(([dr,dc])=>{
    let nr=r+dr,nc=c+dc;
    while(onBoard(nr,nc)){const tg=getAt(board,nr,nc);if(tg){if(tg.s!==s)mv.push([nr,nc]);break;}mv.push([nr,nc]);nr+=dr;nc+=dc;}});}
  else if(t==='C'){[[0,1],[0,-1],[1,0],[-1,0]].forEach(([dr,dc])=>{
    let nr=r+dr,nc=c+dc,j=false;
    while(onBoard(nr,nc)){const tg=getAt(board,nr,nc);
      if(!j){if(tg)j=true;else mv.push([nr,nc]);}
      else{if(tg){if(tg.s!==s)mv.push([nr,nc]);break;}}nr+=dr;nc+=dc;}});}
  else if(t==='P'){
    if(s==='r'){if(r>0)add(r-1,c);if(r<=4){add(r,c+1);add(r,c-1);}}
    else{if(r<9)add(r+1,c);if(r>=5){add(r,c+1);add(r,c-1);}}}
  return mv;
}

function isInCheck(s,board,isHiddenMode=false){
  const k=board.find(p=>p.t==='K'&&p.s===s);
  if(!k)return true;
  const opp=s==='r'?'b':'r';
  return board.filter(p=>p.s===opp).some(p=>getRawMoves(p,board,isHiddenMode).some(([mr,mc])=>mr===k.r&&mc===k.c));
}

function getSafeMoves(p,board,isHiddenMode=false){
  return getRawMoves(p,board,isHiddenMode).filter(([mr,mc])=>{
    const sim=board.filter(x=>!(x.r===mr&&x.c===mc&&x.s!==p.s)).map(x=>({...x}));
    const mp=sim.find(x=>x.id===p.id);if(!mp)return false;
    mp.r=mr;mp.c=mc;return !isInCheck(p.s,sim,isHiddenMode);
  });
}

function hasAnyMoves(s,board,isHiddenMode=false){
  return board.filter(p=>p.s===s).some(p=>getSafeMoves(p,board,isHiddenMode).length>0);
}

function checkResult(board,justMovedSide,isHiddenMode=false){
  const next=justMovedSide==='r'?'b':'r';
  if(!hasAnyMoves(next,board,isHiddenMode))return justMovedSide;
  return null;
}

// ── Socket.IO ──
io.on('connection', socket => {
  console.log(`[+] ${socket.id} kết nối (tổng: ${io.engine.clientsCount})`);

  // Tìm trận
  socket.on('find_match', ({ mode, name, elo=1200 }) => {
    if (!['flash','normal','hidden'].includes(mode)) return;
    const safeName = String(name||'Người Chơi').slice(0,20);
    console.log(`[Q] ${safeName}(${elo}) tìm trận ${mode}`);

    if (queue[mode] && queue[mode].id !== socket.id &&
        io.sockets.sockets.has(queue[mode].id)) {
      // Ghép trận
      const opp = queue[mode];
      queue[mode] = null;

      const roomId = makeRoomId();
      const board = mode === 'hidden' ? mkHiddenBoard() : mkBoard();
      const redFirst = Math.random() < 0.5;
      const p1 = { id: socket.id, name: safeName, side: redFirst?'r':'b', elo };
      const p2 = { id: opp.id, name: opp.name, side: redFirst?'b':'r', elo: opp.elo||1200 };
      const baseTime = { flash:60, normal:600, hidden:300 }[mode];

      rooms[roomId] = {
        id: roomId, mode,
        players: [p1, p2],
        board, turn: 'r',
        moves: [], drawOffer: null,
        spectators: [],
        baseTime, rTime: baseTime, bTime: baseTime,
        startTime: Date.now(), lastMoveTime: null,
        ended: false
      };

      socket.join(roomId);
      io.sockets.sockets.get(opp.id)?.join(roomId);

      const matchData = { roomId, board, turn:'r', mode, baseTime };
      io.to(socket.id).emit('match_found', { ...matchData, side: p1.side, opponent: p2.name, opponentElo: p2.elo });
      io.to(opp.id).emit('match_found', { ...matchData, side: p2.side, opponent: p1.name, opponentElo: p1.elo });
      console.log(`[R] Phòng ${roomId}: ${p1.name}(${p1.side}) vs ${p2.name}(${p2.side})`);

    } else {
      // Chờ đối thủ
      if (queue[mode]) {
        // Xóa người cũ đã offline
        queue[mode] = null;
      }
      queue[mode] = { id: socket.id, name: safeName, elo };
      socket.data.name = safeName;
      socket.data.mode = mode;
      socket.emit('waiting', { mode });
      console.log(`[W] ${safeName} chờ ${mode}`);
    }
  });

  // Hủy tìm trận
  socket.on('cancel_find', () => {
    Object.keys(queue).forEach(m => {
      if (queue[m]?.id === socket.id) queue[m] = null;
    });
  });

  // Di chuyển
  socket.on('move', ({ roomId, pieceId, toR, toC }) => {
    const room = rooms[roomId];
    if (!room || room.ended) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.side !== room.turn) return;

    const piece = room.board.find(p => p.id === pieceId);
    if (!piece) return;

    // Validate nước đi hợp lệ
    const legal = getSafeMoves(piece, room.board, room.mode==='hidden');
    if (!legal.some(([r,c]) => r===toR && c===toC)) {
      socket.emit('move_invalid', { pieceId, toR, toC });
      return;
    }

    // Bắt quân
    const capIdx = room.board.findIndex(p => p.r===toR && p.c===toC && p.s!==piece.s);
    const captured = capIdx !== -1 ? room.board.splice(capIdx, 1)[0] : null;
    const justMoved = piece.s;
    const from = { r: piece.r, c: piece.c };
    piece.r = toR; piece.c = toC;

    // Lật quân cờ úp
    if (room.mode === 'hidden' && piece.hidden) {
      piece.hidden = false; piece.revealed = true; piece.posType = null;
    }

    // Cập nhật đồng hồ
    const now = Date.now();
    if (room.lastMoveTime) {
      const elapsed = Math.floor((now - room.lastMoveTime) / 1000);
      if (justMoved === 'r') room.rTime = Math.max(0, room.rTime - elapsed);
      else room.bTime = Math.max(0, room.bTime - elapsed);
    }
    room.lastMoveTime = now;
    room.turn = room.turn === 'r' ? 'b' : 'r';
    room.moves.push({ pieceId, from, to: { r: toR, c: toC } });

    // Broadcast
    io.to(roomId).emit('moved', {
      pieceId, from, to: { r: toR, c: toC },
      captured: captured ? captured.id : null,
      board: room.board,
      turn: room.turn,
      moveNum: room.moves.length,
      rTime: room.rTime,
      bTime: room.bTime
    });

    // Kiểm tra kết thúc
    const winner = checkResult(room.board, justMoved, room.mode==='hidden');
    if (winner !== null) endGame(roomId, winner, 'Chiếu hết');
  });

  // Chat / emoji
  socket.on('chat', ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const name = player?.name || 'Ẩn danh';
    const safeText = String(text||'').slice(0,100);
    // Chỉ gửi cho người kia trong room (KHÔNG gửi lại cho người gửi)
    socket.to(roomId).emit('chat_msg', { name, text: safeText });
  });

  // Đầu hàng / thoát
  socket.on('resign', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.ended) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const winner = player.side === 'r' ? 'b' : 'r';
    endGame(roomId, winner, 'opponent_quit');
  });

  // Xem live
  socket.on('spectate', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.ended) {
      socket.emit('spectate_error', 'Phòng không tồn tại hoặc đã kết thúc');
      return;
    }
    socket.join(roomId);
    if (!room.spectators) room.spectators = [];
    if (!room.spectators.includes(socket.id)) room.spectators.push(socket.id);

    let rTime = room.rTime || room.baseTime || 600;
    let bTime = room.bTime || room.baseTime || 600;
    if (room.lastMoveTime) {
      const elapsed = Math.floor((Date.now() - room.lastMoveTime) / 1000);
      if (room.turn === 'r') rTime = Math.max(0, rTime - elapsed);
      else bTime = Math.max(0, bTime - elapsed);
    }
    socket.emit('spectate_start', {
      roomId, board: room.board, turn: room.turn,
      players: room.players.map(p => ({ name: p.name, side: p.side, elo: p.elo })),
      moves: room.moves.length, mode: room.mode,
      rTime, bTime, baseTime: room.baseTime || 600,
      lastMoveTime: room.lastMoveTime || Date.now()
    });
  });

  socket.on('stop_spectate', ({ roomId }) => {
    const room = rooms[roomId];
    if (room?.spectators) {
      room.spectators = room.spectators.filter(id => id !== socket.id);
    }
    socket.leave(roomId);
  });

  // Hỏi danh sách phòng qua socket
  socket.on('get_rooms', () => {
    const list = Object.values(rooms)
      .filter(r => r.players.length === 2 && !r.ended)
      .map(r => ({
        id: r.id, mode: r.mode,
        players: r.players.map(p => p.name),
        moves: r.moves.length,
        spectators: r.spectators?.length || 0
      }));
    socket.emit('rooms_list', list);
  });

  // Ngắt kết nối
  socket.on('disconnect', reason => {
    console.log(`[-] ${socket.id} ngắt (${reason})`);
    // Xóa khỏi hàng chờ
    Object.keys(queue).forEach(m => {
      if (queue[m]?.id === socket.id) queue[m] = null;
    });
    // Xử lý phòng đang chơi
    Object.values(rooms).forEach(room => {
      if (room.ended) return;
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        const winner = player.side === 'r' ? 'b' : 'r';
        endGame(room.id, winner, 'opponent_quit');
      }
    });
  });
});

// ── End game ──
function endGame(roomId, winner, reason) {
  const room = rooms[roomId];
  if (!room || room.ended) return;
  room.ended = true;

  io.to(roomId).emit('game_over', { winner, reason });

  // Cập nhật leaderboard với ELO thực tế từ client
  // Server chỉ track thắng/thua/hòa, ELO tính trên client
  if (winner && reason !== 'opponent_quit') {
    const k = { flash:20, normal:15, hidden:25 }[room.mode] || 15;
    room.players.forEach(p => {
      const won = p.side === winner;
      const eloChg = won ? Math.round(k*.9) : -Math.round(k*.7);
      const newElo = Math.max(100, (p.elo || 1200) + eloChg);
      updateLeaderboard(p.name, room.mode, won?'win':'lose', newElo);
    });
  }

  console.log(`[END] ${roomId}: ${winner||'hòa'} — ${reason} (${room.moves.length} nước)`);

  // Dọn dẹp sau 60 giây (để spectator kịp nhận game_over)
  setTimeout(() => {
    delete rooms[roomId];
    console.log(`[DEL] Xóa phòng ${roomId}`);
  }, 60000);
}

// Dọn dẹp phòng trống định kỳ mỗi 5 phút
setInterval(() => {
  const now = Date.now();
  Object.entries(rooms).forEach(([id, room]) => {
    const age = (now - room.startTime) / 1000 / 60; // phút
    const maxAge = { flash: 5, normal: 40, hidden: 20 }[room.mode] || 30;
    if (age > maxAge || room.ended) {
      if (!room.ended) endGame(id, null, 'Hết giờ');
      setTimeout(() => delete rooms[id], 5000);
    }
  });
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚂 Cờ Tướng Server v2.1 chạy tại port ${PORT}`);
});
