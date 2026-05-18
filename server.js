require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const ADMIN_KEY = process.env.ADMIN_KEY;
const MAX_USERNAME_LENGTH = 30;
const MAX_CHAT_LENGTH = 200;
const CHAT_RATE_WINDOW_MS = 1500;
const PENDING_RECONNECT_GRACE_MS = 10000;
const DEVICE_REGISTRY_PATH = path.join(
  __dirname,
  "data",
  "device-registry.json",
);
const chatRateMap = new Map();
const pendingReconnectTimers = new Map();

app.use(express.static("public"));
app.use(express.json());
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

const channels = {
  1: { name: "Media Ministry", users: [], muted: false, adminListening: false },
  2: { name: "Sound Ministry", users: [], muted: false, adminListening: false },
  3: { name: "Protocols", users: [], muted: false, adminListening: false },
  4: { name: "Worship Team", users: [], muted: false, adminListening: false },
  5: { name: "Technical", users: [], muted: false, adminListening: false },
  6: { name: "Ushers", users: [], muted: false, adminListening: false },
  7: { name: "Prayer Team", users: [], muted: false, adminListening: false },
  8: { name: "Administration", users: [], muted: false, adminListening: false },
};

let activeUsers = new Map();
let messages = [];
let pendingUsers = new Map();
let trustedUsers = new Map();
let adminSockets = new Set();

function loadTrustedUsersFromDisk() {
  try {
    if (!fs.existsSync(DEVICE_REGISTRY_PATH)) return;
    const file = fs.readFileSync(DEVICE_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(file);
    if (!parsed || typeof parsed !== "object") return;
    for (const [deviceIp, profile] of Object.entries(parsed)) {
      if (
        typeof deviceIp === "string" &&
        typeof profile === "object" &&
        profile &&
        typeof profile.channelId === "number"
      ) {
        trustedUsers.set(deviceIp, {
          username: String(profile.username || "Guest"),
          channelId: profile.channelId,
          revokedByAdmin: Boolean(profile.revokedByAdmin),
          lastSeenAt: profile.lastSeenAt || null,
        });
      }
    }
  } catch (error) {}
}

function persistTrustedUsersToDisk() {
  try {
    const registryObject = Object.fromEntries(trustedUsers);
    fs.mkdirSync(path.dirname(DEVICE_REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(
      DEVICE_REGISTRY_PATH,
      JSON.stringify(registryObject, null, 2),
      "utf8",
    );
  } catch (error) {}
}

function setTrustedUserProfile(deviceIp, profile) {
  trustedUsers.set(deviceIp, {
    ...profile,
    lastSeenAt: new Date().toISOString(),
  });
  persistTrustedUsersToDisk();
}

function sanitizeUsername(username) {
  if (typeof username !== "string") return null;
  const cleaned = username.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > MAX_USERNAME_LENGTH) return null;
  return cleaned;
}

function normalizeChannelId(channelId) {
  const normalized = Number.parseInt(channelId, 10);
  return Number.isInteger(normalized) ? normalized : null;
}

function resolveTargetChannels(channelIds) {
  if (
    channelIds === "all" ||
    (Array.isArray(channelIds) && channelIds.includes("all"))
  ) {
    return Object.keys(channels).map((id) => Number.parseInt(id, 10));
  }
  if (!Array.isArray(channelIds)) return [];
  const selected = [];
  for (const value of channelIds) {
    const id = normalizeChannelId(value);
    if (id && channels[id] && !selected.includes(id)) {
      selected.push(id);
    }
  }
  return selected;
}

function getDeviceIp(socket) {
  const rawIp =
    socket?.handshake?.address || socket?.request?.socket?.remoteAddress || "";
  if (!rawIp) return "unknown";
  if (rawIp.startsWith("::ffff:")) return rawIp.slice(7);
  return rawIp;
}

function getChannelUsers(channelId) {
  return Array.from(activeUsers.values())
    .filter(
      (user) => !user.isAdmin && !user.pending && user.channelId === channelId,
    )
    .map((user) => user.username);
}

function isChatRateLimited(socketId) {
  const now = Date.now();
  const last = chatRateMap.get(socketId) || 0;
  if (now - last < CHAT_RATE_WINDOW_MS) return true;
  chatRateMap.set(socketId, now);
  return false;
}

function requireAdmin(socket) {
  if (!socket.data || !socket.data.isAdmin) {
    socket.emit("admin-error", { message: "Unauthorized admin action" });
    return false;
  }
  return true;
}

function hasLiveAdminSocket() {
  if (!adminSockets.size) return false;
  for (const socketId of Array.from(adminSockets)) {
    if (!io.sockets.sockets.has(socketId)) {
      adminSockets.delete(socketId);
    }
  }
  return adminSockets.size > 0;
}

function emitAdmin(event, payload) {
  if (hasLiveAdminSocket()) {
    for (const socketId of adminSockets) {
      io.to(socketId).emit(event, payload);
    }
  }
}

function emitAdminSnapshot() {
  emitAdmin("admin-users-update", getAllUsers());
  emitAdmin("admin-channels-update", channels);
  emitAdmin("admin-pending-users-update", Array.from(pendingUsers.values()));
  emitAdmin("admin-known-devices-update", getKnownDevices());
}

function getKnownDevices() {
  const devices = [];
  for (const [deviceIp, profile] of trustedUsers.entries()) {
    devices.push({
      userId: deviceIp,
      deviceIp,
      username: profile.username || "Guest",
      channelId: profile.channelId,
      channelName: channels[profile.channelId]?.name || "Unknown",
      revokedByAdmin: Boolean(profile.revokedByAdmin),
      lastSeenAt: profile.lastSeenAt || null,
    });
  }
  devices.sort((a, b) => {
    const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return bTime - aTime;
  });
  return devices;
}

function clearPendingReconnectTimer(deviceKey) {
  const timer = pendingReconnectTimers.get(deviceKey);
  if (timer) {
    clearTimeout(timer);
    pendingReconnectTimers.delete(deviceKey);
  }
}

function findPendingEntryByDeviceKey(deviceKey) {
  for (const [socketId, pendingUser] of pendingUsers.entries()) {
    if (pendingUser.deviceKey === deviceKey) return { socketId, pendingUser };
  }
  return null;
}

function schedulePendingCleanup(socketId, pendingUser) {
  if (!pendingUser?.deviceKey) return;
  clearPendingReconnectTimer(pendingUser.deviceKey);
  const timer = setTimeout(() => {
    const existing = pendingUsers.get(socketId);
    if (existing && existing.deviceKey === pendingUser.deviceKey) {
      pendingUsers.delete(socketId);
      emitAdminSnapshot();
    }
    pendingReconnectTimers.delete(pendingUser.deviceKey);
  }, PENDING_RECONNECT_GRACE_MS);
  pendingReconnectTimers.set(pendingUser.deviceKey, timer);
}

function disconnectExistingSessionByDeviceKey(deviceKey, nextSocketId) {
  for (const [socketId, user] of activeUsers.entries()) {
    if (
      socketId !== nextSocketId &&
      !user.isAdmin &&
      user.deviceKey === deviceKey
    ) {
      const oldSocket = io.sockets.sockets.get(socketId);
      if (oldSocket) {
        oldSocket.emit("force-disconnect", {
          message: "Session replaced by a new connection",
        });
        oldSocket.disconnect(true);
      } else {
        activeUsers.delete(socketId);
        pendingUsers.delete(socketId);
        chatRateMap.delete(socketId);
      }
    }
  }
  for (const [socketId, pendingUser] of pendingUsers.entries()) {
    if (socketId !== nextSocketId && pendingUser.deviceKey === deviceKey) {
      pendingUsers.delete(socketId);
      activeUsers.delete(socketId);
      chatRateMap.delete(socketId);
    }
  }
}

function finalizeUserJoin(socket, user) {
  const channelId = user.channelId;
  if (!channelId || !channels[channelId]) {
    socket.emit("error", { message: "Invalid channel assignment" });
    return false;
  }
  socket.join(`channel-${channelId}`);
  channels[channelId].users = getChannelUsers(channelId);
  socket.emit("channel-status", {
    channelId: channelId,
    channelName: channels[channelId].name,
    users: getChannelUsers(channelId),
    muted: channels[channelId].muted,
  });
  const channelMessages = messages.filter((m) => m.channelId === channelId);
  socket.emit("message-history", channelMessages);
  io.to(`channel-${channelId}`).emit("users-update", {
    channelId: channelId,
    users: getChannelUsers(channelId),
  });
  setTrustedUserProfile(user.deviceKey, {
    username: user.username,
    channelId: channelId,
    revokedByAdmin: false,
  });

  const peersToConnect = [];
  for (const [id, u] of activeUsers.entries()) {
    if (id !== socket.id && (u.channelId === channelId || u.isAdmin)) {
      peersToConnect.push(id);
    }
  }
  socket.emit("webrtc-peers", { peers: peersToConnect });

  emitAdminSnapshot();
  return true;
}

io.on("connection", (socket) => {
  socket.on("user-ready", (data) => {
    const username = sanitizeUsername(data?.username);
    const deviceKey = getDeviceIp(socket);
    const userId = deviceKey;
    if (!username) {
      socket.emit("error", { message: "Invalid username" });
      return;
    }
    disconnectExistingSessionByDeviceKey(deviceKey, socket.id);
    clearPendingReconnectTimer(deviceKey);
    socket.emit("device-identity", { deviceIp: deviceKey });
    const trustedUser = trustedUsers.get(deviceKey);
    if (
      trustedUser &&
      !trustedUser.revokedByAdmin &&
      channels[trustedUser.channelId]
    ) {
      const restoredUser = {
        socketId: socket.id,
        userId: userId,
        deviceKey: deviceKey,
        username: trustedUser.username || username,
        channelId: trustedUser.channelId,
        joinedAt: new Date(),
        pending: false,
      };
      activeUsers.set(socket.id, restoredUser);
      finalizeUserJoin(socket, restoredUser);
      return;
    }
    const existingPendingEntry = findPendingEntryByDeviceKey(deviceKey);
    if (existingPendingEntry) {
      pendingUsers.delete(existingPendingEntry.socketId);
      activeUsers.delete(existingPendingEntry.socketId);
      const reconnectedPending = {
        ...existingPendingEntry.pendingUser,
        username: username,
        socketId: socket.id,
      };
      activeUsers.set(socket.id, {
        socketId: socket.id,
        deviceKey: deviceKey,
        userId: userId,
        username: username,
        channelId: null,
        joinedAt: new Date(),
        pending: true,
      });
      pendingUsers.set(socket.id, reconnectedPending);
      if (
        reconnectedPending.assignedChannelId &&
        reconnectedPending.joinToken
      ) {
        socket.emit("admin-assigned", {
          channelId: reconnectedPending.assignedChannelId,
          channelName: channels[reconnectedPending.assignedChannelId]?.name,
          joinToken: reconnectedPending.joinToken,
        });
      } else {
        socket.emit("waiting-for-assignment", {
          message: "Waiting for admin to assign you to a channel...",
        });
      }
      emitAdminSnapshot();
      return;
    }
    activeUsers.set(socket.id, {
      socketId: socket.id,
      userId: userId,
      deviceKey: deviceKey,
      username: username,
      channelId: null,
      joinedAt: new Date(),
      pending: true,
    });
    pendingUsers.set(socket.id, {
      username: username,
      userId: userId,
      deviceKey: deviceKey,
      socketId: socket.id,
      assignedChannelId: null,
      joinToken: null,
    });
    if (hasLiveAdminSocket()) {
      emitAdmin("admin-pending-user", {
        userId: userId,
        deviceIp: deviceKey,
        username: username,
        socketId: socket.id,
      });
      emitAdminSnapshot();
    }
    socket.emit("waiting-for-assignment", {
      message: "Waiting for admin to assign you to a channel...",
    });
  });

  socket.on("user-join", (data) => {
    const username = sanitizeUsername(data?.username);
    const channelId = normalizeChannelId(data?.channelId);
    const userId = getDeviceIp(socket);
    const deviceKey = getDeviceIp(socket);
    const joinToken = data?.joinToken;
    const pending = pendingUsers.get(socket.id);
    if (!username || !pending) {
      socket.emit("error", { message: "Invalid join request" });
      return;
    }
    if (
      pending.username !== username ||
      pending.deviceKey !== deviceKey ||
      pending.assignedChannelId !== channelId ||
      pending.joinToken !== joinToken
    ) {
      socket.emit("error", { message: "Unauthorized channel join" });
      return;
    }
    if (!channelId || !channels[channelId]) {
      socket.emit("error", { message: "Invalid channel assignment" });
      return;
    }
    const joinedUser = {
      socketId: socket.id,
      userId: userId,
      deviceKey: deviceKey,
      username: username,
      channelId: channelId,
      joinedAt: new Date(),
      pending: false,
    };
    activeUsers.set(socket.id, joinedUser);
    pendingUsers.delete(socket.id);
    finalizeUserJoin(socket, joinedUser);
  });

  socket.on("webrtc-signal", (data) => {
    io.to(data.target).emit("webrtc-signal", {
      sender: socket.id,
      signal: data.signal,
    });
  });

  socket.on("audio-start", () => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.channelId || !channels[user.channelId]) return;
    if (channels[user.channelId].muted) {
      socket.emit("channel-muted", {
        message: "Channel is currently muted by admin",
      });
      return;
    }
    socket
      .to(`channel-${user.channelId}`)
      .emit("user-talking", { username: user.username, isTalking: true });
    if (channels[user.channelId].adminListening) {
      emitAdmin("admin-audio-start", {
        channelId: user.channelId,
        channelName: channels[user.channelId].name,
        username: user.username,
      });
    }
  });

  socket.on("audio-stop", () => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.channelId || !channels[user.channelId]) return;
    socket
      .to(`channel-${user.channelId}`)
      .emit("user-talking", { username: user.username, isTalking: false });
    if (channels[user.channelId].adminListening) {
      emitAdmin("admin-audio-stop", {
        channelId: user.channelId,
        username: user.username,
      });
    }
  });

  socket.on("chat-message", (data) => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.channelId) return;
    if (isChatRateLimited(socket.id)) return;
    const content =
      typeof data?.message === "string" ? data.message.trim() : "";
    if (!content || content.length > MAX_CHAT_LENGTH) return;
    const message = {
      id: uuidv4(),
      userId: user.userId,
      username: user.username,
      channelId: user.channelId,
      message: content,
      timestamp: new Date(),
    };
    messages.push(message);
    if (messages.length > 100) messages = messages.slice(-100);
    io.to(`channel-${user.channelId}`).emit("chat-message", message);
    emitAdmin("admin-chat-message", message);
  });

  socket.on("send-vibrate", () => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.channelId) return;
    if (isChatRateLimited(socket.id)) return;

    socket
      .to(`channel-${user.channelId}`)
      .emit("receive-vibrate", { username: user.username });
  });

  socket.on("clear-chat", (data) => {
    if (requireAdmin(socket)) {
      const channelId = data?.channelId;
      if (channelId === "all") {
        messages = [];
        io.emit("chat-cleared");
      } else {
        const normalizedChannelId = normalizeChannelId(channelId);
        if (!normalizedChannelId || !channels[normalizedChannelId]) return;
        messages = messages.filter((m) => m.channelId !== normalizedChannelId);
        io.to(`channel-${normalizedChannelId}`).emit("chat-cleared");
      }
    }
  });

  socket.on("disconnect", () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      if (user.isAdmin) {
        activeUsers.delete(socket.id);
        adminSockets.delete(socket.id);
        chatRateMap.delete(socket.id);
        return;
      }
      if (user.channelId && channels[user.channelId]) {
        const channelId = user.channelId;
        channels[channelId].users = getChannelUsers(channelId).filter(
          (username) => username !== user.username,
        );
        io.to(`channel-${channelId}`).emit("users-update", {
          channelId: channelId,
          users: getChannelUsers(channelId),
        });
        io.to(`channel-${channelId}`).emit("user-disconnected", {
          username: user.username,
          socketId: socket.id,
        });
        emitAdmin("user-disconnected", { socketId: socket.id });
      } else if (pendingUsers.has(socket.id)) {
        schedulePendingCleanup(socket.id, pendingUsers.get(socket.id));
      }
      activeUsers.delete(socket.id);
      chatRateMap.delete(socket.id);
      emitAdminSnapshot();
    }
    if (adminSockets.has(socket.id)) adminSockets.delete(socket.id);
  });

  socket.on("admin-register", (data) => {
    const adminKey = data?.adminKey;
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      socket.emit("admin-error", { message: "Admin authentication failed" });
      socket.disconnect(true);
      return;
    }
    adminSockets.add(socket.id);
    socket.data.isAdmin = true;
    for (const [existingSocketId, existingUser] of activeUsers.entries()) {
      if (existingUser?.isAdmin && existingSocketId !== socket.id) {
        activeUsers.delete(existingSocketId);
      }
    }
    activeUsers.set(socket.id, {
      socketId: socket.id,
      userId: "admin",
      username: "Admin",
      channelId: "admin",
      joinedAt: new Date(),
      isAdmin: true,
      pending: false,
    });
    socket.emit("admin-initial-data", {
      users: getAllUsers(),
      channels: channels,
      messages: messages,
      pendingUsers: Array.from(pendingUsers.values()),
      knownDevices: getKnownDevices(),
    });

    const allUserSockets = Array.from(activeUsers.keys()).filter(
      (id) => id !== socket.id,
    );
    socket.emit("webrtc-peers", { peers: allUserSockets });
  });

  socket.on("admin-assign-channel", (data) => {
    if (!requireAdmin(socket)) return;
    const { socketId, channelId, username, userId, deviceIp } = data;
    const normalizedChannelId = normalizeChannelId(channelId);
    if (!channels[normalizedChannelId]) {
      socket.emit("admin-error", { message: "Invalid channel number" });
      return;
    }
    let resolvedSocketId = socketId;
    let pendingUser = pendingUsers.get(socketId);
    if (!pendingUser) {
      const deviceKey = deviceIp || userId;
      const pendingEntry = deviceKey
        ? findPendingEntryByDeviceKey(deviceKey)
        : null;
      if (pendingEntry) {
        resolvedSocketId = pendingEntry.socketId;
        pendingUser = pendingEntry.pendingUser;
      }
    }
    const targetSocket = resolvedSocketId
      ? io.sockets.sockets.get(resolvedSocketId)
      : null;
    if (targetSocket && pendingUser) {
      const joinToken = crypto.randomBytes(16).toString("hex");
      pendingUser.assignedChannelId = normalizedChannelId;
      pendingUser.joinToken = joinToken;
      pendingUsers.set(resolvedSocketId, pendingUser);
      setTrustedUserProfile(pendingUser.deviceKey, {
        username: pendingUser.username,
        channelId: normalizedChannelId,
        revokedByAdmin: false,
      });
      targetSocket.emit("admin-assigned", {
        channelId: normalizedChannelId,
        channelName: channels[normalizedChannelId].name,
        joinToken: joinToken,
      });
      showNotificationToAdmin(
        `Assigned ${username} to ${channels[normalizedChannelId].name}`,
      );
    } else {
      socket.emit("admin-error", { message: "User not found" });
    }
  });

  socket.on("admin-change-channel", (data) => {
    if (!requireAdmin(socket)) return;
    const { socketId, newChannelId } = data;
    const normalizedChannelId = normalizeChannelId(newChannelId);
    if (!channels[normalizedChannelId]) {
      socket.emit("admin-error", { message: "Invalid channel number" });
      return;
    }
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      const user = activeUsers.get(socketId);
      if (user && !user.isAdmin) {
        if (user.channelId && channels[user.channelId]) {
          const oldChannelId = user.channelId;
          channels[oldChannelId].users = getChannelUsers(oldChannelId).filter(
            (username) => username !== user.username,
          );
          targetSocket.leave(`channel-${oldChannelId}`);
          io.to(`channel-${oldChannelId}`).emit("users-update", {
            channelId: oldChannelId,
            users: getChannelUsers(oldChannelId),
          });
          io.to(`channel-${oldChannelId}`).emit("user-disconnected", {
            username: user.username,
            socketId: socket.id,
          });
        }
        user.channelId = normalizedChannelId;
        user.pending = false;
        activeUsers.set(socketId, user);
        setTrustedUserProfile(user.deviceKey, {
          username: user.username,
          channelId: normalizedChannelId,
          revokedByAdmin: false,
        });
        targetSocket.join(`channel-${normalizedChannelId}`);
        channels[normalizedChannelId].users =
          getChannelUsers(normalizedChannelId);
        targetSocket.emit("channel-changed", {
          newChannelId: newChannelId,
          newChannelName: channels[normalizedChannelId].name,
        });
        targetSocket.emit("channel-status", {
          channelId: normalizedChannelId,
          channelName: channels[normalizedChannelId].name,
          users: getChannelUsers(normalizedChannelId),
          muted: channels[normalizedChannelId].muted,
        });
        io.to(`channel-${normalizedChannelId}`).emit("users-update", {
          channelId: normalizedChannelId,
          users: getChannelUsers(normalizedChannelId),
        });

        const peersToConnect = [];
        for (const [id, u] of activeUsers.entries()) {
          if (
            id !== targetSocket.id &&
            (u.channelId === normalizedChannelId || u.isAdmin)
          ) {
            peersToConnect.push(id);
          }
        }
        targetSocket.emit("webrtc-peers", { peers: peersToConnect });

        showNotificationToAdmin(
          `Moved ${user.username} to ${channels[normalizedChannelId].name}`,
        );
      }
    }
    emitAdminSnapshot();
  });

  socket.on("admin-disconnect-user", (data) => {
    if (!requireAdmin(socket)) return;
    const { socketId } = data;
    const targetSocket = io.sockets.sockets.get(socketId);
    const targetUser = activeUsers.get(socketId);
    if (targetUser && targetUser.deviceKey) {
      setTrustedUserProfile(targetUser.deviceKey, {
        username: targetUser.username,
        channelId: targetUser.channelId,
        revokedByAdmin: true,
      });
    }
    if (targetSocket) {
      targetSocket.emit("force-disconnect", {
        message: "Disconnected by admin",
      });
      targetSocket.disconnect(true);
    }
  });

  socket.on("admin-mute-channel", (data) => {
    if (!requireAdmin(socket)) return;
    const channelId = normalizeChannelId(data?.channelId);
    const muted = Boolean(data?.muted);
    if (channelId && channels[channelId]) {
      channels[channelId].muted = muted;
      io.to(`channel-${channelId}`).emit("channel-mute-status", {
        muted: muted,
      });
      emitAdmin("admin-channels-update", channels);
      showNotificationToAdmin(
        `${muted ? "Muted" : "Unmuted"} ${channels[channelId].name}`,
      );
    }
  });

  socket.on("admin-listen-channel", (data) => {
    if (!requireAdmin(socket)) return;
    const channelId = normalizeChannelId(data?.channelId);
    const listening = Boolean(data?.listening);
    if (channelId && channels[channelId]) {
      channels[channelId].adminListening = listening;
      emitAdmin("admin-channels-update", channels);
    }
  });

  socket.on("admin-system-message", (data) => {
    if (!requireAdmin(socket)) return;
    const channelIds =
      data?.channelIds !== undefined ? data.channelIds : data?.channelId;
    const message =
      typeof data?.message === "string" ? data.message.trim() : "";
    if (!message || message.length > MAX_CHAT_LENGTH) return;
    const systemMsg = {
      id: uuidv4(),
      username: "SYSTEM",
      message: message,
      isSystem: true,
      level: "alert",
      timestamp: new Date(),
    };
    const targets = resolveTargetChannels(channelIds);
    if (targets.length === Object.keys(channels).length) {
      io.emit("system-message", systemMsg);
      emitAdmin("admin-system-message-log", { ...systemMsg, channelId: "ALL" });
      showNotificationToAdmin(`Broadcast to all: ${message}`);
      return;
    }
    if (targets.length === 0) return;
    for (const targetId of targets) {
      io.to(`channel-${targetId}`).emit("system-message", systemMsg);
    }
    const targetNames = targets.map((id) => channels[id].name).join(", ");
    emitAdmin("admin-system-message-log", {
      ...systemMsg,
      channelId: targets.join(","),
    });
    showNotificationToAdmin(`Broadcast to ${targetNames}: ${message}`);
  });

  socket.on("admin-send-vibrate", (data) => {
    if (!requireAdmin(socket)) return;
    const channelIds =
      data?.channelIds !== undefined ? data.channelIds : data?.channelId;
    const targets = resolveTargetChannels(channelIds);

    if (targets.length === Object.keys(channels).length) {
      io.emit("receive-vibrate", { username: "ADMIN" });
      showNotificationToAdmin(`Nudge sent to all channels`);
      return;
    }

    if (targets.length === 0) return;
    for (const targetId of targets) {
      io.to(`channel-${targetId}`).emit("receive-vibrate", {
        username: "ADMIN",
      });
    }
    showNotificationToAdmin(`Nudge sent to channels: ${targets.join(", ")}`);
  });

  socket.on("admin-audio-broadcast-start", (data) => {
    if (!requireAdmin(socket)) return;
    const targets = resolveTargetChannels(data?.channelIds);
    if (targets.length === 0) return;
    emitAdmin("admin-notification", {
      message:
        targets.length === Object.keys(channels).length
          ? "Admin audio broadcast started to ALL channels"
          : `Admin audio broadcast started to channels ${targets.join(",")}`,
      type: "info",
    });
  });

  socket.on("admin-audio-broadcast-stop", () => {
    if (!requireAdmin(socket)) return;
    emitAdmin("admin-notification", {
      message: "Admin audio broadcast stopped",
      type: "info",
    });
  });

  socket.on("admin-refresh-request", () => {
    if (!requireAdmin(socket)) return;
    emitAdminSnapshot();
  });
});

function getAllUsers() {
  const users = [];
  for (let [socketId, user] of activeUsers) {
    if (!user.isAdmin) {
      users.push({
        socketId: user.socketId,
        userId: user.userId,
        deviceIp: user.deviceKey || "unknown",
        username: user.username,
        channelId: user.channelId || "pending",
        channelName: user.channelId
          ? channels[user.channelId]?.name || "Unknown"
          : "Waiting for assignment",
        joinedAt: user.joinedAt,
        pending: user.pending || false,
      });
    }
  }
  return users;
}

function showNotificationToAdmin(message) {
  emitAdmin("admin-notification", { message: message, type: "info" });
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

const PORT = process.env.PORT || 3000;

if (!ADMIN_KEY) {
  console.error("\nCRITICAL ERROR: Missing ADMIN_KEY in your .env file!");
  console.error(
    "Please add ADMIN_KEY=your_secret_password to your .env file and restart.\n",
  );
  process.exit(1);
}

loadTrustedUsersFromDisk();

server.listen(PORT, "0.0.0.0", () => {
  const localIp = getLocalIp();
  console.log("\n========================================");
  console.log("IC24 Media TALK - Server Active");
  console.log("========================================");
  console.log(`Server running on port ${PORT}`);
  console.log(`Local Network URL : http://${localIp}:${PORT}`);
  console.log(`This PC URL       : http://localhost:${PORT}`);
  console.log(`Admin Dashboard  : http://${localIp}:${PORT}/dashboard.html`);
  console.log("========================================\n");
});
