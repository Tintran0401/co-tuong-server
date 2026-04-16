/*
  CỜ TƯỚNG ONLINE — Backend Server
  Node.js + Socket.IO
  Deploy: Railway.app
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET','POST']
  },
  // Railway cần cả polling lẫn websocket
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json());
// Cần thiết cho Socket.IO polling trên Railway
app.get('/', (_, res) => res.send('Cờ Tướng Server đang chạy ✅'));
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

// ── ROOMS ──
// rooms[roomId] = { id, mode, players:[{id,name,side}], board, turn, moves, spectators:[] }
const rooms = {};
// queue[mode] = socketId đang chờ
const queue = { flash: null, normal: null, hidden: null };

function makeRoomId() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}

// ── INITIAL BOARD ──
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
  // Xáo trộn MỖI PHE trong sân của mình
  ['r','b'].forEach(side=>{
    const pieces = board.filter(p => p.s === side && p.t !== 'K');
    const positions = pieces.map(p => ({ r: p.r, c: p.c }));
    // Fisher-Yates shuffle trong sân phe đó
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    pieces.forEach((p, i) => { p.r = positions[i].r; p.c = positions[i].c; });
    // Úp mặt tất cả trừ tướng
    pieces.forEach(p => { p.hidden = true; p.revealed = false; });
  });
  // Tướng ngửa
  board.filter(p => p.t === 'K').forEach(p => { p.hidden = false; p.revealed = true; });
  return board;
}

// ── CHESS LOGIC TRÊN SERVER ──
function onBoard(r,c){return r>=0&&r<10&&c>=0&&c<9;}
function inPalace(r,c,s){return s==='r'?(r>=7&&r<=9&&c>=3&&c<=5):(r>=0&&r<=2&&c>=3&&c<=5);}
function getAt(board,r,c){return board.find(p=>p.r===r&&p.c===c)||null;}

function getRawMoves(p,board){
  const mv=[],{t,s,r,c}=p;
  const add=(nr,nc)=>{
    if(!onBoard(nr,nc))return;
    const tg=getAt(board,nr,nc);
    if(tg&&tg.s===s)return;
    mv.push([nr,nc]);
  };
  if(t==='K'){[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>{const nr=r+dr,nc=c+dc;if(inPalace(nr,nc,s))add(nr,nc);});}
  else if(t==='A'){[[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dr,dc])=>{const nr=r+dr,nc=c+dc;if(inPalace(nr,nc,s))add(nr,nc);});}
  else if(t==='B'){[[2,2],[2,-2],[-2,2],[-2,-2]].forEach(([dr,dc])=>{
    const nr=r+dr,nc=c+dc;if(!onBoard(nr,nc))return;
    if(getAt(board,r+dr/2,c+dc/2))return;
    if(s==='r'&&nr<5)return;if(s==='b'&&nr>4)return;add(nr,nc);});}
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

function isInCheck(s,board){
  const k=board.find(p=>p.t==='K'&&p.s===s);
  if(!k)return true; // tướng bị bắt = thua
  const opp=s==='r'?'b':'r';
  return board.filter(p=>p.s===opp).some(p=>getRawMoves(p,board).some(([mr,mc])=>mr===k.r&&mc===k.c));
}

function getSafeMoves(p,board){
  return getRawMoves(p,board).filter(([mr,mc])=>{
    const sim=board.filter(x=>!(x.r===mr&&x.c===mc&&x.s!==p.s)).map(x=>({...x}));
    const mp=sim.find(x=>x.id===p.id);
    if(!mp)return false;mp.r=mr;mp.c=mc;
    return !isInCheck(p.s,sim);
  });
}

function hasAnyMoves(s,board){
  return board.filter(p=>p.s===s).some(p=>getSafeMoves(p,board).length>0);
}

function checkResult(board,justMovedSide){
  // Phe tiếp theo
  const next=justMovedSide==='r'?'b':'r';
  // Không còn nước đi hợp lệ = thua (chiếu bí hoặc hết nước)
  if(!hasAnyMoves(next,board)){
    return justMovedSide; // phe vừa đi thắng
  }
  return null; // chưa kết thúc
}

// ── SOCKET EVENTS ──
io.on('connection', socket => {
  console.log(`[+] ${socket.id} kết nối`);

  // Tìm trận
  socket.on('find_match', ({ mode, name }) => {
    console.log(`[Q] ${name} tìm trận ${mode}`);

    if (queue[mode] && queue[mode] !== socket.id) {
      // Tìm thấy đối thủ — tạo phòng
      const opponentId = queue[mode];
      queue[mode] = null;

      const roomId = makeRoomId();
      const board = mode === 'hidden' ? mkHiddenBoard() : mkBoard();

      // Random ai đỏ ai đen
      const redFirst = Math.random() < 0.5;
      const p1 = { id: socket.id,   name, side: redFirst ? 'r' : 'b' };
      const p2 = { id: opponentId,  name: io.sockets.sockets.get(opponentId)?.data?.name || 'Đối Thủ', side: redFirst ? 'b' : 'r' };

      rooms[roomId] = {
        id: roomId, mode,
        players: [p1, p2],
        board, turn: 'r',
        moves: [], drawOffer: null,
        spectators: []
      };

      socket.join(roomId);
      io.sockets.sockets.get(opponentId)?.join(roomId);

      // Thông báo bắt đầu cho cả 2
      io.to(socket.id).emit('match_found', {
        roomId, side: p1.side, opponent: p2.name,
        board, turn: 'r', mode,
        baseTime: { flash:60, normal:600, hidden:300 }[mode]
      });
      io.to(opponentId).emit('match_found', {
        roomId, side: p2.side, opponent: p1.name,
        board, turn: 'r', mode,
        baseTime: { flash:60, normal:600, hidden:300 }[mode]
      });

      console.log(`[R] Phòng ${roomId}: ${p1.name}(${p1.side}) vs ${p2.name}(${p2.side})`);

    } else {
      // Chưa có đối thủ — vào hàng chờ
      queue[mode] = socket.id;
      socket.data.name = name;
      socket.data.mode = mode;
      socket.emit('waiting', { mode });
      console.log(`[W] ${name} đang chờ ${mode}`);
    }
  });

  // Hủy tìm trận
  socket.on('cancel_find', () => {
    Object.keys(queue).forEach(m => {
      if (queue[m] === socket.id) queue[m] = null;
    });
    console.log(`[-] ${socket.id} hủy tìm trận`);
  });

  // Di chuyển quân
  socket.on('move', ({ roomId, pieceId, toR, toC }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.side !== room.turn) return; // không phải lượt

    // Thực hiện nước đi trên server
    const piece = room.board.find(p => p.id === pieceId);
    if (!piece) return;

    // Lật quân cờ úp
    if (room.mode === 'hidden' && piece.hidden) {
      piece.hidden = false; piece.revealed = true;
    }

    // Bắt quân
    const capIdx = room.board.findIndex(p => p.r === toR && p.c === toC && p.s !== piece.s);
    let captured = null;
    if (capIdx !== -1) {
      captured = room.board[capIdx];
      room.board.splice(capIdx, 1);
    }

    const justMoved = piece.s; // phe vừa đi
    const from = { r: piece.r, c: piece.c };
    piece.r = toR; piece.c = toC;

    // Đổi lượt
    room.turn = room.turn === 'r' ? 'b' : 'r';
    room.moves.push({ pieceId, from, to: { r: toR, c: toC } });

    // Broadcast nước đi cho cả phòng
    io.to(roomId).emit('moved', {
      pieceId, from, to: { r: toR, c: toC },
      captured: captured ? captured.id : null,
      board: room.board,
      turn: room.turn,
      moveNum: room.moves.length
    });

    // Kiểm tra kết thúc ngay sau khi broadcast
    const winner = checkResult(room.board, justMoved);
    if (winner !== null) {
      endGame(roomId, winner, 'Chiếu hết');
    }
  });

  // Chat
  socket.on('chat', ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const name = player?.name || 'Ẩn danh';
    io.to(roomId).emit('chat_msg', { name, text, time: Date.now() });
  });

  // Cầu hòa
  socket.on('offer_draw', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.drawOffer = socket.id;
    const opp = room.players.find(p => p.id !== socket.id);
    if (opp) io.to(opp.id).emit('draw_offered');
  });

  socket.on('accept_draw', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.drawOffer === socket.id) return;
    endGame(roomId, null, 'Hòa cờ');
  });

  socket.on('decline_draw', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.drawOffer = null;
    const offerer = room.players.find(p => p.id === room.drawOffer);
    if (offerer) io.to(offerer.id).emit('draw_declined');
  });

  // Đầu hàng
  socket.on('resign', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const winner = player.side === 'r' ? 'b' : 'r';
    endGame(roomId, winner, 'Đầu hàng');
  });

  // Xem ván
  socket.on('spectate', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', 'Phòng không tồn tại'); return; }
    socket.join(roomId);
    room.spectators.push(socket.id);
    socket.emit('spectate_start', {
      board: room.board, turn: room.turn,
      players: room.players, moves: room.moves, mode: room.mode
    });
  });

  // Danh sách phòng đang chơi (cho màn spectate)
  socket.on('get_rooms', () => {
    const list = Object.values(rooms).map(r => ({
      id: r.id, mode: r.mode,
      players: r.players.map(p => p.name),
      moves: r.moves.length,
      spectators: r.spectators.length
    }));
    socket.emit('rooms_list', list);
  });

  // Ngắt kết nối
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} ngắt kết nối`);

    // Xóa khỏi hàng chờ
    Object.keys(queue).forEach(m => {
      if (queue[m] === socket.id) queue[m] = null;
    });

    // Nếu đang trong phòng → đối thủ thắng
    Object.values(rooms).forEach(room => {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        const winner = player.side === 'r' ? 'b' : 'r';
        endGame(room.id, winner, 'Đối thủ mất kết nối');
      }
    });
  });
});

function endGame(roomId, winner, reason) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('game_over', { winner, reason });
  console.log(`[END] Phòng ${roomId}: ${winner || 'hòa'} — ${reason}`);
  // Xóa phòng sau 30 giây
  setTimeout(() => delete rooms[roomId], 30000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚂 Server chạy tại port ${PORT}`));
