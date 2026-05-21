const socket = io({ autoConnect: false });

let mediaStream = null;
let audioContext = null;
let isTalking = false;
let isLatched = false;
let currentChannel = null;
let pendingJoinToken = null;
let staticNoiseBuffer = null;
let userId = localStorage.getItem("deviceIp") || "Detecting...";
let username = localStorage.getItem("username") || "";

const peerConnections = {};
const rtcConfig = {
  iceServers: [],
  iceCandidatePoolSize: 4,
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
};
const audioElementsContainer = document.createElement("div");
audioElementsContainer.style.display = "none";
document.body.appendChild(audioElementsContainer);

const usernameInput = document.getElementById("username");
const saveUsernameBtn = document.getElementById("saveUsernameBtn");
const userIdSpan = document.getElementById("userId");
const waveformCanvas = document.getElementById("waveform");
const signalIndicator = document.getElementById("signalIndicator");
const serverStatusCard = document.getElementById("serverStatus");
const micStatusCard = document.getElementById("micStatus");
const channelStatusSpan = document.getElementById("channelName");
const pttButton = document.getElementById("pttButton");
const latchModeCheckbox = document.getElementById("latchMode");
const volumeSlider = document.getElementById("volumeSlider");
const volumeValue = document.getElementById("volumeValue");
const peersListDiv = document.getElementById("peersList");
const peerCountSpan = document.getElementById("peerCount");
const chatMessagesDiv = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");
const clearChatBtn = document.getElementById("clearChatBtn");
const sendVibrateBtn = document.getElementById("sendVibrateBtn");

saveUsernameBtn.addEventListener("click", () => {
  const newUsername = usernameInput.value.trim();
  if (newUsername) {
    username = newUsername;
    localStorage.setItem("username", username);
    alert("Username saved! Reconnect to update.");
    location.reload();
  }
});

async function init() {
  userIdSpan.textContent = userId;
  if (username) {
    usernameInput.value = username;
  } else {
    username = "Guest";
    usernameInput.value = username;
  }
  await initMicrophone();
  connectToServer();
  setupVolumeControl();
  setupWaveform();
}

async function initMicrophone() {
  try {
    updateMicStatus("Requesting...", false);
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    mediaStream.getAudioTracks()[0].enabled = false;
    updateMicStatus("Active", true);
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
      sampleRate: 48000,
    });
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const analyser = audioContext.createAnalyser();
    analyser.smoothingTimeConstant = 0.85;
    analyser.fftSize = 512;
    sourceNode.connect(analyser);
    visualizeWaveform(analyser);
  } catch (error) {
    updateMicStatus("Error", false);
  }
}

function visualizeWaveform(analyser) {
  const canvas = waveformCanvas;
  const ctx = canvas.getContext("2d");
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const freqArray = new Uint8Array(analyser.frequencyBinCount);
  const smoothBars = new Array(32).fill(0);

  function draw() {
    if (!canvas.isConnected) return;
    analyser.getByteTimeDomainData(dataArray);
    analyser.getByteFrequencyData(freqArray);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barCount = 32;
    const barWidth = canvas.width / barCount - 2;
    let x = 0;
    const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, "#10b981");
    gradient.addColorStop(0.6, "#f59e0b");
    gradient.addColorStop(1, "#ef4444");
    for (let i = 0; i < barCount; i++) {
      const targetValue = isTalking ? freqArray[i * 2] : 0;
      smoothBars[i] += (targetValue - smoothBars[i]) * 0.2;
      const barHeight = Math.max(4, (smoothBars[i] / 255) * canvas.height);
      ctx.fillStyle = isTalking ? gradient : "#334155";
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(
          x,
          canvas.height - barHeight,
          barWidth,
          barHeight,
          [2, 2, 0, 0],
        );
        ctx.fill();
      } else {
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
      }
      x += barWidth + 2;
    }
    let maxSample = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const sample = Math.abs(dataArray[i] - 128) / 128;
      if (sample > maxSample) maxSample = sample;
    }
    if (maxSample > 0.1 && isTalking) {
      signalIndicator.querySelector(".signal-dot").classList.add("active");
      signalIndicator.querySelector(".signal-text").textContent = "Talking...";
    } else {
      signalIndicator.querySelector(".signal-dot").classList.remove("active");
      signalIndicator.querySelector(".signal-text").textContent = isTalking
        ? "Idle"
        : "Ready";
    }
    requestAnimationFrame(draw);
  }
  draw();
}

function connectToServer() {
  updateServerStatus("Connecting...", false);
  const onConnected = () => {
    updateServerStatus("Connected", true);
    socket.emit("user-ready", { username: username });
    updateChannelStatus("Waiting for assignment...");
  };
  socket.on("connect", () => onConnected());
  socket.on("disconnect", () => {
    updateServerStatus("Disconnected", false);
    Object.keys(peerConnections).forEach(cleanupPeer);
  });
  socket.on("device-identity", (data) => {
    if (data?.deviceIp) {
      userId = data.deviceIp;
      localStorage.setItem("deviceIp", data.deviceIp);
      userIdSpan.textContent = data.deviceIp;
    }
  });
  socket.connect();
  if (socket.connected) onConnected();

  socket.on("waiting-for-assignment", (data) => {
    updateChannelStatus("Waiting for admin...");
    addSystemMessage(data.message, "warning");
  });
  socket.on("admin-assigned", (data) => {
    addSystemMessage(`Admin assigned you to ${data.channelName}`, "success");
    pendingJoinToken = data.joinToken;
    socket.emit("user-join", {
      username: username,
      channelId: data.channelId,
      joinToken: pendingJoinToken,
    });
  });
  socket.on("channel-changed", (data) => {
    currentChannel = data.newChannelId;
    localStorage.setItem("assignedChannel", currentChannel);
    updateChannelStatus(data.newChannelName);
    addSystemMessage(
      `You have been moved to ${data.newChannelName}`,
      "success",
    );
    Object.keys(peerConnections).forEach(cleanupPeer);
  });
  socket.on("channel-status", (data) => {
    currentChannel = data.channelId;
    updateChannelStatus(data.channelName);
    updatePeersList(data.users);
    if (data.muted)
      addSystemMessage("This channel has been muted by admin", "alert");
  });
  socket.on("users-update", (data) => {
    if (data.channelId == currentChannel) updatePeersList(data.users);
  });
  socket.on("user-talking", (data) => {
    highlightTalkingPeer(data.username, data.isTalking);
  });
  socket.on("chat-message", (data) => {
    addChatMessage(data.username, data.message, data.timestamp);
  });
  socket.on("system-message", (data) => {
    addSystemMessage(
      data.message,
      data.level === "alert" ? "alert" : "warning",
    );
  });
  socket.on("message-history", (messages) => {
    messages.forEach((msg) =>
      addChatMessage(msg.username, msg.message, msg.timestamp),
    );
  });
  socket.on("chat-cleared", () => {
    chatMessagesDiv.innerHTML = '<div class="placeholder">Chat cleared</div>';
  });
  socket.on("channel-mute-status", (data) => {
    if (data.muted) {
      addSystemMessage("Channel has been muted by admin", "alert");
      stopTalking();
    } else {
      addSystemMessage("Channel has been unmuted", "success");
    }
  });
  socket.on("force-disconnect", (data) => {
    alert(data.message);
    setTimeout(() => location.reload(), 2000);
  });
  socket.on("user-disconnected", (data) => {
    if (data.socketId) cleanupPeer(data.socketId);
  });

  socket.on("receive-vibrate", (data) => {
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200]);
    }

    document.body.classList.add("shake-screen");
    setTimeout(() => document.body.classList.remove("shake-screen"), 500);
    playNotificationPing();

    addSystemMessage(`Attention: ${data.username} sent a nudge!`, "alert");
  });

  socket.on("webrtc-peers", (data) => {
    data.peers.forEach((peerId) => createPeerConnection(peerId, true));
  });

  socket.on("webrtc-signal", async (data) => {
    const { sender, signal } = data;
    let pc = peerConnections[sender];
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
}

function createPeerConnection(targetSocketId, initiate) {
  if (peerConnections[targetSocketId]) return peerConnections[targetSocketId];
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[targetSocketId] = pc;

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, mediaStream);
      if (sender.track.kind === "audio") {
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings[0].priority = "high";
          params.encodings[0].networkPriority = "high";
          sender.setParameters(params).catch(() => {});
        }
      }
    });
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
      audioEl.setAttribute("playsinline", "");
      audioElementsContainer.appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
    audioEl.volume = volumeSlider.value / 100;

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
  if (peerConnections[socketId]) {
    peerConnections[socketId].close();
    delete peerConnections[socketId];
  }
  const audioEl = document.getElementById(`audio-${socketId}`);
  if (audioEl) audioEl.remove();
}

pttButton.addEventListener("mousedown", (e) => {
  if (latchModeCheckbox.checked) {
    if (!isLatched) engageLatch();
  } else {
    if (isLatched) {
      releaseLatch();
      return;
    }
    startTalking();
  }
});
pttButton.addEventListener("mouseup", stopTalking);
pttButton.addEventListener("mouseleave", stopTalking);
pttButton.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (latchModeCheckbox.checked) {
    if (!isLatched) engageLatch();
  } else {
    if (isLatched) {
      releaseLatch();
      return;
    }
    startTalking();
  }
});
pttButton.addEventListener("touchend", stopTalking);

function startTalking(force = false) {
  if (isLatched && !force) return;
  if (!mediaStream) return;
  if (isTalking) return;
  isTalking = true;
  pttButton.classList.add("talking");
  if (audioContext && audioContext.state === "suspended") audioContext.resume();
  mediaStream.getAudioTracks()[0].enabled = true;
  playPttStatic("in");
  socket.emit("audio-start");
}

function stopTalking() {
  if (isLatched) return;
  if (!isTalking) return;
  isTalking = false;
  pttButton.classList.remove("talking");
  if (mediaStream) mediaStream.getAudioTracks()[0].enabled = false;
  playPttStatic("out");
  socket.emit("audio-stop");
}

function engageLatch() {
  if (isLatched) return;
  startTalking(true);
  isLatched = true;
  pttButton.classList.add("latched", "talking");
}

function releaseLatch() {
  if (!isLatched) return;
  isLatched = false;
  pttButton.classList.remove("latched", "talking");
  stopTalking();
}

function ensureStaticNoiseBuffer() {
  if (!audioContext || staticNoiseBuffer) return;
  const duration = 0.14;
  const frameCount = Math.floor(audioContext.sampleRate * duration);
  staticNoiseBuffer = audioContext.createBuffer(
    1,
    frameCount,
    audioContext.sampleRate,
  );
  const channelData = staticNoiseBuffer.getChannelData(0);
  for (let i = 0; i < frameCount; i++)
    channelData[i] = (Math.random() * 2 - 1) * 0.7;
}

async function playPttStatic(direction) {
  try {
    if (!audioContext)
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();
    ensureStaticNoiseBuffer();
    if (!staticNoiseBuffer) return;
    const source = audioContext.createBufferSource();
    source.buffer = staticNoiseBuffer;
    const gainNode = audioContext.createGain();
    const filterNode = audioContext.createBiquadFilter();
    filterNode.type = "bandpass";
    filterNode.frequency.value = direction === "in" ? 1900 : 1500;
    filterNode.Q.value = 0.9;
    const now = audioContext.currentTime;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.23, now + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    source.connect(filterNode);
    filterNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.start(now);
    source.stop(now + 0.135);
  } catch (error) {}
}

function setupVolumeControl() {
  volumeSlider.addEventListener("input", (e) => {
    const val = e.target.value;
    volumeValue.textContent = val + "%";
    document.querySelectorAll("#audioElements audio").forEach((el) => {
      el.volume = val / 100;
    });
  });
}

function updateServerStatus(status, isOnline) {
  serverStatusCard.querySelector(".status-value").textContent = status;
  if (isOnline) serverStatusCard.classList.add("online");
  else serverStatusCard.classList.remove("online");
}

function updateMicStatus(status, isActive) {
  micStatusCard.querySelector(".status-value").textContent = status;
  if (isActive) micStatusCard.classList.add("online");
  else micStatusCard.classList.remove("online");
}

function updateChannelStatus(channelName) {
  channelStatusSpan.textContent = channelName;
}

function updatePeersList(users) {
  const filteredUsers = users.filter((u) => u !== username);
  peerCountSpan.textContent = `(${filteredUsers.length})`;
  if (filteredUsers.length === 0) {
    peersListDiv.innerHTML =
      '<div class="placeholder">No other users in this channel</div>';
    return;
  }
  peersListDiv.innerHTML = filteredUsers
    .map(
      (user) => `
    <div class="peer-card" data-username="${user}">
      <div class="peer-avatar"></div>
      <div class="peer-name">${escapeHtml(user)}</div>
    </div>
  `,
    )
    .join("");
}

function highlightTalkingPeer(username, isTalking) {
  const peerCard = document.querySelector(
    `.peer-card[data-username="${username}"]`,
  );
  if (peerCard) {
    if (isTalking) peerCard.classList.add("talking");
    else peerCard.classList.remove("talking");
  }
}

function addChatMessage(username, message, timestamp) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "chat-message";
  messageDiv.innerHTML = `
    <div class="message-header">
      <span class="message-username">${escapeHtml(username)}</span>
      <span class="message-time">${new Date(timestamp).toLocaleTimeString()}</span>
    </div>
    <div class="message-text">${escapeHtml(message)}</div>
  `;
  chatMessagesDiv.appendChild(messageDiv);
  chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
  const placeholder = chatMessagesDiv.querySelector(".placeholder");
  if (placeholder) placeholder.remove();
}

function addSystemMessage(message, level = "warning") {
  const messageDiv = document.createElement("div");
  messageDiv.className = `chat-message system system-${level}`;
  messageDiv.innerHTML = `<div class="message-text">${escapeHtml(message)}</div>`;
  chatMessagesDiv.appendChild(messageDiv);
  chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
  const placeholder = chatMessagesDiv.querySelector(".placeholder");
  if (placeholder) placeholder.remove();
}

sendChatBtn.addEventListener("click", () => {
  const message = chatInput.value.trim();
  if (message) {
    socket.emit("chat-message", { message: message });
    chatInput.value = "";
  }
});

if (sendVibrateBtn) {
  sendVibrateBtn.addEventListener("click", () => {
    socket.emit("send-vibrate");
    addSystemMessage("Vibration nudge sent to channel.", "success");
  });
}

chatInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendChatBtn.click();
});

clearChatBtn.addEventListener("click", () => {
  if (confirm("Clear all chat messages?")) {
    chatMessagesDiv.innerHTML = '<div class="placeholder">Chat cleared</div>';
  }
});

function playNotificationPing() {
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioContext.currentTime); // High pitch
    osc.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + 0.1);

    gain.gain.setValueAtTime(0, audioContext.currentTime);
    gain.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start();
    osc.stop(audioContext.currentTime + 0.5);
  } catch (e) {}
}

function setupWaveform() {
  waveformCanvas.width = waveformCanvas.clientWidth;
  waveformCanvas.height = waveformCanvas.clientHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

window.addEventListener("resize", () => {
  waveformCanvas.width = waveformCanvas.clientWidth;
});

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

init();
