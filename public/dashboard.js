const totalUsersSpan = document.getElementById("totalUsers");
const totalMessagesSpan = document.getElementById("totalMessages");
const usersListDiv = document.getElementById("usersList");
const channelsListDiv = document.getElementById("channelsList");
const pendingUsersListDiv = document.getElementById("pendingUsersList");
const broadcastAllCheckbox = document.getElementById("broadcastAll");
const broadcastChannelCheckboxes = Array.from(
  document.querySelectorAll(".broadcast-channel"),
);
const broadcastMessage = document.getElementById("broadcastMessage");
const sendBroadcastBtn = document.getElementById("sendBroadcastBtn");
const sendVibrateBtn = document.getElementById("sendVibrateBtn");
const startAudioBroadcastBtn = document.getElementById(
  "startAudioBroadcastBtn",
);
const stopAudioBroadcastBtn = document.getElementById("stopAudioBroadcastBtn");
const listenAllBtn = document.getElementById("listenAllBtn");
const stopListenAllBtn = document.getElementById("stopListenAllBtn");
const muteAllBtn = document.getElementById("muteAllBtn");
const unmuteAllBtn = document.getElementById("unmuteAllBtn");
const serverTimeSpan = document.getElementById("serverTime");
const refreshUsersBtn = document.getElementById("refreshUsersBtn");
const pendingCountBadge = document.getElementById("pendingCountBadge");
const navPendingBadge = document.getElementById("navPendingBadge");
const reconnectBadge = document.getElementById("reconnectBadge");
const knownDevicesListDiv = document.getElementById("knownDevicesList");

let currentUsers = [];
let currentChannels = {};
let currentPendingUsers = [];
let currentKnownDevices = [];
let messageLog = [];
let adminTxMediaStream = null;
let adminBroadcastingAudio = false;

const adminPeerConnections = {};
const rtcConfig = {
  iceServers: [],
  iceCandidatePoolSize: 4,
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
};
const audioElementsContainer = document.createElement("div");
audioElementsContainer.style.display = "none";
document.body.appendChild(audioElementsContainer);

const socket = io();
let adminAuthenticated = false;

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".nav-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".dashboard-section")
      .forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.target).classList.add("active");
  });
});

async function initAdminMic() {
  if (!adminTxMediaStream) {
    try {
      adminTxMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      adminTxMediaStream.getAudioTracks()[0].enabled = false;
    } catch (e) {}
  }
}

function getAdminKey() {
  let key = localStorage.getItem("adminKey") || "";
  if (!key) key = prompt("Enter admin access key");
  if (!key) {
    showNotification("Admin key is required", "error");
    return null;
  }
  localStorage.setItem("adminKey", key);
  return key;
}

socket.on("connect", () => {
  updateReconnectBadge(false);
  const adminKey = getAdminKey();
  if (!adminKey) {
    updateAdminStatus(false);
    return;
  }
  socket.emit("admin-register", { adminKey });
});

socket.on("disconnect", () => {
  updateAdminStatus(false);
  updateReconnectBadge(true);
  stopAudioBroadcast(false);
  Object.keys(adminPeerConnections).forEach(cleanupPeer);
});

socket.io.on("reconnect_attempt", () => updateReconnectBadge(true));
socket.io.on("reconnect", () => updateReconnectBadge(false));

socket.on("admin-initial-data", (data) => {
  adminAuthenticated = true;
  updateAdminStatus(true);
  initAdminMic();
  currentUsers = data.users || [];
  currentChannels = data.channels || {};
  currentPendingUsers = data.pendingUsers || [];
  currentKnownDevices = data.knownDevices || [];
  messageLog = data.messages || [];
  updateUsersList(currentUsers);
  updateChannelsList(currentChannels);
  updatePendingUsersList(currentPendingUsers);
  updateKnownDevicesList(currentKnownDevices);
  renderMessageLog(messageLog);
  updateStats();
  updatePendingCount();
});

socket.on("admin-users-update", (users) => {
  currentUsers = users;
  updateUsersList(users);
  updateStats();
  updateAdminAudioMutes();
});

socket.on("admin-channels-update", (channels) => {
  currentChannels = channels;
  updateChannelsList(channels);
  updateAdminAudioMutes();
});

socket.on("admin-pending-user", (user) => {
  if (!currentPendingUsers.find((u) => u.socketId === user.socketId)) {
    currentPendingUsers.push(user);
    updatePendingUsersList(currentPendingUsers);
    updateStats();
    updatePendingCount();
    playNotificationSound();
    showNotification(`New authorization request: ${user.username}`, "info");
  }
});

socket.on("admin-pending-users-update", (pendingUsers) => {
  currentPendingUsers = pendingUsers || [];
  updatePendingUsersList(currentPendingUsers);
  updatePendingCount();
  updateStats();
});

socket.on("admin-known-devices-update", (devices) => {
  currentKnownDevices = devices || [];
  updateKnownDevicesList(currentKnownDevices);
});

socket.on("admin-chat-message", (message) => {
  messageLog.push(message);
  addToMessageLog(message);
  updateStats();
});

socket.on("admin-system-message-log", (message) => {
  messageLog.push(message);
  addToMessageLog(message);
  updateStats();
});

socket.on("admin-audio-start", (data) => {
  highlightUserTalking(data.username, true);
  updateNowPlaying(`RECEIVING: ${data.username} [${data.channelName}]`);
});

socket.on("admin-audio-stop", (data) => {
  highlightUserTalking(data.username, false);
  updateNowPlaying("Monitoring Idle");
});

socket.on("admin-error", (data) => {
  showNotification(data.message, "error");
  if (
    String(data.message || "")
      .toLowerCase()
      .includes("auth")
  ) {
    localStorage.removeItem("adminKey");
    adminAuthenticated = false;
  }
});

socket.on("user-disconnected", (data) => {
  if (data.socketId) cleanupPeer(data.socketId);
});

socket.on("webrtc-peers", (data) => {
  data.peers.forEach((peerId) => createPeerConnection(peerId, true));
});

socket.on("webrtc-signal", async (data) => {
  const { sender, signal } = data;
  let pc = adminPeerConnections[sender];
  if (signal.type === "offer") {
    if (!pc) pc = createPeerConnection(sender, false);
    await pc.setRemoteDescription(new RTCSessionDescription(signal));
    const answer = await pc.createAnswer({ voiceActivityDetection: false });
    answer.sdp = setOpusLowLatency(answer.sdp);
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-signal", {
      target: sender,
      signal: pc.localDescription,
    });
  } else if (signal.type === "answer") {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal));
  } else if (signal.type === "candidate") {
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
  }
});

function createPeerConnection(targetSocketId, initiate) {
  if (adminPeerConnections[targetSocketId])
    return adminPeerConnections[targetSocketId];
  const pc = new RTCPeerConnection(rtcConfig);
  adminPeerConnections[targetSocketId] = pc;

  if (adminTxMediaStream) {
    adminTxMediaStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, adminTxMediaStream);
      if (sender.track.kind === "audio") {
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings[0].priority = "high";
          params.encodings[0].networkPriority = "high";
          sender.setParameters(params).catch(() => {});
        }
      }
    });
    const sender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (sender) sender.replaceTrack(null);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("webrtc-signal", {
        target: targetSocketId,
        signal: { type: "candidate", candidate: e.candidate },
      });
    }
  };

  pc.ontrack = (e) => {
    let audioEl = document.getElementById(`audio-${targetSocketId}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `audio-${targetSocketId}`;
      audioEl.autoplay = true;
      audioEl.muted = true;
      audioEl.setAttribute("playsinline", "");
      audioElementsContainer.appendChild(audioEl);
      updateAdminAudioMutes();
    }
    audioEl.srcObject = e.streams[0];

    const receiver = pc.getReceivers().find((r) => r.track === e.track);
    if (receiver && "jitterBufferTarget" in receiver) {
      receiver.jitterBufferTarget = 0;
    }
  };

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "disconnected" ||
      pc.connectionState === "failed" ||
      pc.connectionState === "closed"
    ) {
      cleanupPeer(targetSocketId);
    }
  };

  if (initiate) {
    pc.createOffer({ voiceActivityDetection: false })
      .then((offer) => {
        offer.sdp = setOpusLowLatency(offer.sdp);
        return pc.setLocalDescription(offer);
      })
      .then(() => {
        socket.emit("webrtc-signal", {
          target: targetSocketId,
          signal: pc.localDescription,
        });
      });
  }
  return pc;
}

function cleanupPeer(socketId) {
  if (adminPeerConnections[socketId]) {
    adminPeerConnections[socketId].close();
    delete adminPeerConnections[socketId];
  }
  const audioEl = document.getElementById(`audio-${socketId}`);
  if (audioEl) audioEl.remove();
}

function updateAdminAudioMutes() {
  currentUsers.forEach((user) => {
    const audioEl = document.getElementById(`audio-${user.socketId}`);
    if (audioEl) {
      const channel = currentChannels[user.channelId];
      audioEl.muted = !(channel && channel.adminListening);
    }
  });
}

function updateServerTime() {
  if (serverTimeSpan) serverTimeSpan.textContent = new Date().toLocaleString();
}
setInterval(updateServerTime, 1000);
updateServerTime();

function updateAdminStatus(isConnected) {
  const badge = document.getElementById("serverStatusBadge");
  if (badge) {
    if (isConnected) {
      badge.innerHTML = '<span class="status-dot"></span> Server Online';
      badge.className = "status-indicator online";
    } else {
      badge.innerHTML = '<span class="status-dot"></span> Server Disconnected';
      badge.className = "status-indicator offline";
    }
  }
}

function updateReconnectBadge(isReconnecting) {
  if (reconnectBadge)
    reconnectBadge.classList.toggle("hidden", !isReconnecting);
}

function updateStats() {
  if (totalUsersSpan)
    totalUsersSpan.textContent = currentUsers.filter((u) => !u.pending).length;
  if (totalMessagesSpan) totalMessagesSpan.textContent = messageLog.length;
  if (document.getElementById("pendingCount"))
    document.getElementById("pendingCount").textContent =
      currentPendingUsers.length;
}

function updatePendingCount() {
  const count = currentPendingUsers ? currentPendingUsers.length : 0;
  if (pendingCountBadge) pendingCountBadge.textContent = count > 0 ? count : "";
  if (navPendingBadge) {
    navPendingBadge.textContent = count;
    navPendingBadge.style.display = count > 0 ? "inline-block" : "none";
  }
}

function updateKnownDevicesList(devices) {
  if (!knownDevicesListDiv) return;
  if (!devices || devices.length === 0) {
    knownDevicesListDiv.innerHTML =
      '<div class="empty-state">No known devices yet</div>';
    return;
  }
  knownDevicesListDiv.innerHTML = devices
    .map((device) => {
      const pClass = device.revokedByAdmin ? "revoked" : "allowed";
      const pText = device.revokedByAdmin ? "Revoked" : "Allowed";
      return `
      <div class="grid-card">
        <div class="grid-header">
          <div class="grid-title">${escapeHtml(device.username)}</div>
          <div class="pill ${pClass}">${pText}</div>
        </div>
        <div class="grid-meta">
          CH: ${escapeHtml(device.channelName)} (${device.channelId})<br>
          IP: ${escapeHtml(device.deviceIp || String(device.userId))}<br>
          Seen: ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "N/A"}
        </div>
      </div>
    `;
    })
    .join("");
}

function updateUsersList(users) {
  if (!usersListDiv) return;
  const activeUsers = users.filter((u) => !u.pending);
  if (activeUsers.length === 0) {
    usersListDiv.innerHTML = '<div class="empty-state">No active users</div>';
    return;
  }
  usersListDiv.innerHTML = activeUsers
    .map(
      (user) => `
    <div class="list-item" data-userid="${user.userId}" data-socketid="${user.socketId}">
      <div class="item-main">
        <div class="item-title user-name">
          ${escapeHtml(user.username)}
          ${user.isTalking ? '<span class="tx-badge">TX ACTIVE</span>' : ""}
        </div>
        <div class="item-meta">
          CH: ${escapeHtml(user.channelName)} (${user.channelId}) | ID: ${user.userId.substring(0, 8)}...
        </div>
      </div>
      <div class="item-actions">
        <select class="channel-select" data-userid="${user.userId}">
          ${generateChannelOptions(user.channelId)}
        </select>
        <button class="action-btn red" onclick="disconnectUser('${user.socketId}')">Disconnect</button>
      </div>
    </div>
  `,
    )
    .join("");
  document.querySelectorAll(".channel-select").forEach((select) => {
    select.addEventListener("change", () => {
      const user = activeUsers.find((u) => u.userId === select.dataset.userid);
      if (user) changeUserChannel(user.socketId, parseInt(select.value));
    });
  });
}

function generateChannelOptions(currentChannel) {
  let options = "";
  for (let i = 1; i <= 8; i++) {
    const channelName = currentChannels[i]?.name || `Channel ${i}`;
    options += `<option value="${i}" ${currentChannel == i ? "selected" : ""}>CH-${i}: ${channelName}</option>`;
  }
  return options;
}

function updatePendingUsersList(pendingUsers) {
  if (!pendingUsersListDiv) return;
  if (!pendingUsers || pendingUsers.length === 0) {
    pendingUsersListDiv.innerHTML =
      '<div class="empty-state">No pending requests</div>';
    return;
  }
  pendingUsersListDiv.innerHTML = pendingUsers
    .map(
      (user) => `
    <div class="list-item pending-tx" data-socketid="${user.socketId}">
      <div class="item-main">
        <div class="item-title">${escapeHtml(user.username)}</div>
        <div class="item-meta">Connected: ${new Date().toLocaleTimeString()}</div>
      </div>
      <div class="item-actions">
        <select id="pendingChannel_${user.socketId}">${generateChannelOptions(null)}</select>
        <button class="action-btn green" onclick="assignChannelToUser('${user.socketId}', '${user.userId}', '${escapeHtml(user.username)}', '${user.deviceIp || user.deviceKey || user.userId}')">Authorize</button>
      </div>
    </div>
  `,
    )
    .join("");
}

function updateChannelsList(channels) {
  if (!channelsListDiv) return;
  channelsListDiv.innerHTML = Object.entries(channels)
    .map(
      ([id, channel]) => `
    <div class="grid-card">
      <div class="grid-header">
        <div class="grid-title">CH-${id}: ${escapeHtml(channel.name)}</div>
        <div class="status-pills">
          ${channel.muted ? '<div class="pill muted">Muted</div>' : '<div class="pill active">Active</div>'}
          ${channel.adminListening ? '<div class="pill listening">Monitoring</div>' : ""}
        </div>
      </div>
      <div class="grid-meta">Active Nodes: ${channel.users.length} (${channel.users.join(", ") || "None"})</div>
      <div class="grid-actions">
        <button class="action-btn ${channel.muted ? "green" : "red"}" onclick="toggleMuteChannel(${id}, ${!channel.muted})">${channel.muted ? "Unmute" : "Mute"}</button>
        <button class="action-btn ${channel.adminListening ? "gray" : "blue"}" onclick="toggleListenChannel(${id}, ${!channel.adminListening})">${channel.adminListening ? "Stop Monitor" : "Monitor"}</button>
      </div>
    </div>
  `,
    )
    .join("");
}

function assignChannelToUser(socketId, userId, username, deviceIp) {
  if (!adminAuthenticated) return;
  const channelSelect =
    document.querySelector(`#pendingChannel_${socketId}`) ||
    document.querySelector(`.channel-select[data-userid="${userId}"]`);
  let channelId = channelSelect
    ? parseInt(channelSelect.value)
    : parseInt(prompt(`Assign ${username} to channel (1-8):`, "1"));
  if (channelId && channelId >= 1 && channelId <= 8) {
    socket.emit("admin-assign-channel", {
      socketId,
      channelId,
      userId,
      deviceIp,
      username,
    });
    showNotification(`Authorized ${username} on CH-${channelId}`, "success");
    currentPendingUsers = currentPendingUsers.filter(
      (u) => u.socketId !== socketId,
    );
    updatePendingUsersList(currentPendingUsers);
    updatePendingCount();
    updateStats();
  }
}

function changeUserChannel(socketId, newChannelId) {
  if (!adminAuthenticated) return;
  socket.emit("admin-change-channel", { socketId, newChannelId });
  showNotification("Channel reassignment sent", "success");
}

function disconnectUser(socketId) {
  if (!adminAuthenticated) return;
  if (confirm("Sever connection for this node?")) {
    socket.emit("admin-disconnect-user", { socketId });
    showNotification("Connection severed", "warning");
  }
}

function toggleMuteChannel(channelId, muted) {
  if (!adminAuthenticated) return;
  socket.emit("admin-mute-channel", { channelId, muted });
  showNotification(`CH-${channelId} ${muted ? "muted" : "unmuted"}`, "info");
}

function toggleListenChannel(channelId, listening) {
  if (!adminAuthenticated) return;
  socket.emit("admin-listen-channel", { channelId, listening });
  showNotification(
    `Monitor ${listening ? "engaged" : "disengaged"} for CH-${channelId}`,
    "info",
  );
}

if (listenAllBtn)
  listenAllBtn.addEventListener("click", () => {
    for (let i = 1; i <= 8; i++)
      socket.emit("admin-listen-channel", { channelId: i, listening: true });
    showNotification("Global monitoring engaged", "info");
  });

if (stopListenAllBtn)
  stopListenAllBtn.addEventListener("click", () => {
    for (let i = 1; i <= 8; i++)
      socket.emit("admin-listen-channel", { channelId: i, listening: false });
    showNotification("Global monitoring disengaged", "info");
  });

if (muteAllBtn)
  muteAllBtn.addEventListener("click", () => {
    if (confirm("Enforce global mute across all channels?")) {
      for (let i = 1; i <= 8; i++)
        socket.emit("admin-mute-channel", { channelId: i, muted: true });
      showNotification("Global mute enforced", "warning");
    }
  });

if (unmuteAllBtn)
  unmuteAllBtn.addEventListener("click", () => {
    for (let i = 1; i <= 8; i++)
      socket.emit("admin-mute-channel", { channelId: i, muted: false });
    showNotification("Global mute lifted", "success");
  });

if (broadcastAllCheckbox) {
  broadcastAllCheckbox.addEventListener("change", () => {
    if (broadcastAllCheckbox.checked)
      broadcastChannelCheckboxes.forEach((cb) => (cb.checked = false));
  });
}

broadcastChannelCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => {
    if (cb.checked && broadcastAllCheckbox)
      broadcastAllCheckbox.checked = false;
  });
});

function getBroadcastTargets() {
  if (broadcastAllCheckbox?.checked) return "all";
  const selected = broadcastChannelCheckboxes
    .filter((cb) => cb.checked)
    .map((cb) => parseInt(cb.value, 10));
  return selected.length > 0 ? selected : null;
}

if (sendBroadcastBtn)
  sendBroadcastBtn.addEventListener("click", () => {
    if (!adminAuthenticated) return;
    const targets = getBroadcastTargets();
    const message = broadcastMessage?.value.trim();
    if (!targets) return showNotification("Select target channel", "error");
    if (message) {
      socket.emit("admin-system-message", { channelIds: targets, message });
      if (broadcastMessage) broadcastMessage.value = "";
      showNotification("Transmission sent", "success");
    }
  });

if (sendVibrateBtn)
  sendVibrateBtn.addEventListener("click", () => {
    if (!adminAuthenticated) return;
    const targets = getBroadcastTargets();
    if (!targets) return showNotification("Select target channel", "error");
    socket.emit("admin-send-vibrate", { channelIds: targets });
    showNotification("Nudge sent", "success");
  });

async function startAudioBroadcast() {
  if (!adminAuthenticated || adminBroadcastingAudio) return;
  const targets = getBroadcastTargets();
  if (!targets) return showNotification("Select target channel", "error");

  await initAdminMic();
  const adminAudioTrack = adminTxMediaStream.getAudioTracks()[0];

  Object.entries(adminPeerConnections).forEach(([socketId, pc]) => {
    const user = currentUsers.find((u) => u.socketId === socketId);
    const isTarget =
      targets === "all" || (user && targets.includes(parseInt(user.channelId)));
    const sender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (sender && isTarget) sender.replaceTrack(adminAudioTrack);
    else if (sender) sender.replaceTrack(null);
  });

  adminAudioTrack.enabled = true;
  adminBroadcastingAudio = true;
  socket.emit("admin-audio-broadcast-start", { channelIds: targets });
  updateNowPlaying("TRANSMITTING LIVE AUDIO");
  if (startAudioBroadcastBtn) startAudioBroadcastBtn.disabled = true;
  if (stopAudioBroadcastBtn) stopAudioBroadcastBtn.disabled = false;
}

function stopAudioBroadcast(notifyServer = true) {
  if (adminTxMediaStream) {
    adminTxMediaStream.getAudioTracks()[0].enabled = false;
  }
  Object.values(adminPeerConnections).forEach((pc) => {
    const sender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (sender) sender.replaceTrack(null);
  });
  if (notifyServer && adminBroadcastingAudio)
    socket.emit("admin-audio-broadcast-stop");
  adminBroadcastingAudio = false;
  if (startAudioBroadcastBtn) startAudioBroadcastBtn.disabled = false;
  if (stopAudioBroadcastBtn) stopAudioBroadcastBtn.disabled = true;
  updateNowPlaying("Monitoring Idle");
}

if (startAudioBroadcastBtn)
  startAudioBroadcastBtn.addEventListener("click", startAudioBroadcast);
if (stopAudioBroadcastBtn)
  stopAudioBroadcastBtn.addEventListener("click", () =>
    stopAudioBroadcast(true),
  );
if (refreshUsersBtn)
  refreshUsersBtn.addEventListener("click", () => {
    if (adminAuthenticated) socket.emit("admin-refresh-request");
  });

function highlightUserTalking(username, isTalking) {
  document.querySelectorAll(".list-item").forEach((el) => {
    const nameSpan = el.querySelector(".user-name");
    if (nameSpan && nameSpan.textContent.includes(username)) {
      if (isTalking) {
        el.classList.add("active-tx");
        if (!el.querySelector(".tx-badge")) {
          const badge = document.createElement("span");
          badge.className = "tx-badge";
          badge.textContent = "TX ACTIVE";
          nameSpan.appendChild(badge);
        }
      } else {
        el.classList.remove("active-tx");
        const badge = el.querySelector(".tx-badge");
        if (badge) badge.remove();
      }
    }
  });
}

function updateNowPlaying(text) {
  const monitorDiv = document.getElementById("audioMonitor");
  if (monitorDiv)
    monitorDiv.innerHTML = `<div class="monitor-status ${text !== "Monitoring Idle" ? "active" : ""}">${escapeHtml(text)}</div>`;
}

function renderMessageLog(items) {
  const logDiv = document.getElementById("messageLog");
  if (!logDiv) return;
  logDiv.innerHTML = "";
  if (!items || items.length === 0) {
    logDiv.innerHTML =
      '<div class="empty-state">No intercepted communications</div>';
    return;
  }
  items.forEach((item) => addToMessageLog(item));
}

function addToMessageLog(message) {
  const logDiv = document.getElementById("messageLog");
  if (!logDiv) return;
  const empty = logDiv.querySelector(".empty-state");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "log-entry";
  el.innerHTML = `
    <span class="log-time">[${new Date(message.timestamp).toLocaleTimeString()}]</span>
    <span class="log-chan">[CH-${message.channelId}]</span>
    <span class="log-user">${escapeHtml(message.username)}:</span>
    <span class="log-msg">${escapeHtml(message.message)}</span>
  `;
  logDiv.appendChild(el);
  logDiv.scrollTop = logDiv.scrollHeight;
  while (logDiv.children.length > 100) logDiv.removeChild(logDiv.firstChild);
}

function showNotification(message, type = "info") {
  const notif = document.createElement("div");
  notif.className = `notification ${type}`;
  notif.textContent = message;
  document.body.appendChild(notif);
  setTimeout(() => notif.classList.add("show"), 10);
  setTimeout(() => {
    notif.classList.remove("show");
    setTimeout(() => notif.remove(), 300);
  }, 3000);
}

function playNotificationSound() {
  try {
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.connect(gain);
    gain.connect(actx.destination);
    osc.frequency.value = 800;
    gain.gain.value = 0.1;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.00001, actx.currentTime + 0.5);
    osc.stop(actx.currentTime + 0.5);
    actx.resume();
  } catch (e) {}
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

window.disconnectUser = disconnectUser;
window.assignChannelToUser = assignChannelToUser;
window.toggleMuteChannel = toggleMuteChannel;
window.toggleListenChannel = toggleListenChannel;
window.changeUserChannel = changeUserChannel;

setInterval(() => {
  if (socket.connected && adminAuthenticated)
    socket.emit("admin-refresh-request");
}, 10000);

function setOpusLowLatency(sdp) {
  sdp = sdp.replace(/a=ptime:\d+\r\n/g, "");
  sdp = sdp.replace(/a=maxptime:\d+\r\n/g, "");
  sdp = sdp.replace(
    /(m=audio[^\r\n]*\r\n)/g,
    "$1a=ptime:20\r\na=maxptime:20\r\n",
  );
  sdp = sdp.replace(/a=fmtp:(\d+) (.*opus.*)\r\n/gi, (match, pt, params) => {
    const paramMap = {};
    params.split(";").forEach((p) => {
      const [k, v] = p.trim().split("=");
      if (k) paramMap[k.trim()] = v !== undefined ? v.trim() : "1";
    });
    paramMap["useinbandfec"] = "0";
    paramMap["stereo"] = "0";
    paramMap["sprop-stereo"] = "0";
    paramMap["cbr"] = "1";
    paramMap["maxaveragebitrate"] = "32000";
    const newParams = Object.entries(paramMap)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    return `a=fmtp:${pt} ${newParams}\r\n`;
  });
  return sdp;
}
