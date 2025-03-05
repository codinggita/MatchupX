const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.url} from ${req.headers.origin}`);
  next();
});

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = ['http://localhost:5173', 'https://matchupx.netlify.app'];
    if (!origin || allowedOrigins.includes(origin)) {
      console.log(`CORS allowed for: ${origin}`);
      callback(null, true);
    } else {
      console.log(`CORS blocked for: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // Added PATCH and OPTIONS
  credentials: true,
}));

// Socket.IO configuration
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const allowedOrigins = ['http://localhost:5173', 'https://matchupx.netlify.app'];
      if (!origin || allowedOrigins.includes(origin)) {
        console.log(`Socket.IO CORS allowed for: ${origin}`);
        callback(null, true);
      } else {
        console.log(`Socket.IO CORS blocked for: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], // Optional alignment
    credentials: true,
  },
});

app.use((req, res, next) => {
  req.io = io;
  next();
});

app.use(express.json());
app.use('/api', apiRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Server is running');
});

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    const HOST = '0.0.0.0';
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, HOST, () => {
      console.log(`Server running on ${HOST}:${PORT}`);
    }).on('error', (err) => {
      console.error('Server startup error:', err);
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} in use, trying ${PORT + 1}...`);
        server.listen(PORT + 1, HOST);
      }
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

module.exports = app;