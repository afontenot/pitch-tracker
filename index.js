// UI Flow Controllers & Async State
let audioCtx, analyser, audioData, worker;
let isProcessing = false;
let currentPitch = NaN;
let currentRms = 0;

const canvas = document.getElementById('viz-layer');
const ctx = canvas.getContext('2d');
const noteEl = document.getElementById('note');
const freqEl = document.getElementById('freq');
const startBtn = document.getElementById('start-btn');
const loading = document.getElementById('loading');

const pitchHistory = [];
const HISTORY_DURATION_MS = 10000;

// Core Pitch Range Constants for Drawing
const F_MIN = 55.0;
const F_MAX = 1760.0;
const yMinLog = Math.log2(F_MIN);
const yMaxLog = Math.log2(F_MAX);

// Cache Static Canvas Elements (Grid lines and text)
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d');

function drawBackgroundCache() {
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    bgCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    bgCtx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    bgCtx.lineWidth = 1;
    bgCtx.font = '14px sans-serif';

    const gridFreqs = [55, 110, 220, 440, 880, 1760];
    for(let i = 0; i < gridFreqs.length; i++) {
        const y = bgCanvas.height - bgCanvas.height * ((Math.log2(gridFreqs[i]) - yMinLog) / (yMaxLog - yMinLog));
        bgCtx.beginPath();
        bgCtx.moveTo(0, y);
        bgCtx.lineTo(bgCanvas.width, y);
        bgCtx.stroke();
        bgCtx.fillText(gridFreqs[i] + " Hz", 20, y - 8);
    }
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;
    drawBackgroundCache();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

startBtn.addEventListener('click', async () => {
    startBtn.style.display = 'none';
    loading.style.display = 'block';

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Set up the analyser node
        analyser = audioCtx.createAnalyser();
        const required_max_ws = Math.pow(2, Math.ceil(Math.log2((8 / F_MIN) * audioCtx.sampleRate)));
        analyser.fftSize = Math.min(Math.max(required_max_ws, 256), 32768);
        audioData = new Float32Array(analyser.fftSize);

        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        // RTSwipe background worker
        worker = new Worker('rtswipe.ww.js');

        worker.onmessage = function(e) {
            if (e.data.type === 'ready') {
                document.getElementById('start-overlay').classList.add('hidden');
                document.getElementById('ui').classList.remove('hidden');
                requestAnimationFrame(renderLoop);
            } else if (e.data.type === 'result') {
                currentPitch = e.data.pitch;
                isProcessing = false; // Free the lock to accept the next frame
            }
        };

        // Tell worker to do its heavy initialization
        worker.postMessage({ type: 'init', sampleRate: audioCtx.sampleRate });

    } catch (err) {
        alert("Microphone permission denied or unsupported. Please allow microphone access.");
        startBtn.style.display = 'block';
        loading.style.display = 'none';
    }
});

// Main Draw Loop
function renderLoop() {
    requestAnimationFrame(renderLoop);
    const now = performance.now();
    analyser.getFloatTimeDomainData(audioData);

    // Fast ambient noise gate computation on main thread
    let rmsSq = 0;
    for(let i = 0; i < audioData.length; i += 16) rmsSq += audioData[i] * audioData[i];
    currentRms = Math.sqrt(rmsSq / (audioData.length / 16));

    // Throttle async requests to the worker to avoid message queue flooding
    if (!isProcessing) {
        if (currentRms > 0.01) {
            isProcessing = true;
            // Send a clone of the Float32Array data to the worker
            worker.postMessage({ type: 'process', audioData: audioData });
        } else {
            currentPitch = NaN;
        }
    }

    // Always update history buffer to keep timeline moving
    if (!isNaN(currentPitch) && currentPitch > 0 && currentRms > 0.01) {
        pitchHistory.push({ time: now, pitch: currentPitch });
    } else {
        pitchHistory.push({ time: now, pitch: null });
    }

    while (pitchHistory.length > 0 && now - pitchHistory[0].time > HISTORY_DURATION_MS) {
        pitchHistory.shift();
    }

    // Update DOM Text Elements
    if (!isNaN(currentPitch) && currentPitch > 0 && currentRms > 0.01) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        let noteNum = 69 + 12 * Math.log2(currentPitch / 440);
        let roundedNote = Math.round(noteNum);
        let cents = Math.round((noteNum - roundedNote) * 100);

        noteEl.innerText = `${notes[roundedNote % 12]}${Math.floor(roundedNote / 12) - 1}`;
        freqEl.innerText = `${currentPitch.toFixed(1)} Hz (${cents >= 0 ? '+' : ''}${cents}c)`;

        let hue = Math.max(0, 130 - Math.abs(cents) * 4);
        noteEl.style.color = `hsl(${hue}, 85%, 65%)`;
    } else {
        noteEl.innerText = "--";
        freqEl.innerText = currentRms > 0.01 ? "Unclear signal" : "Quiet";
        noteEl.style.color = "rgba(255, 255, 255, 0.2)";
    }

    // --- CANVAS RENDERING ---
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Stamp Cached Background
    ctx.drawImage(bgCanvas, 0, 0);

    // Background Waveform
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.15)';
    ctx.lineWidth = 2;

    const step = 4; // Skip 3 out of every 4 points to save pathing time
    const sliceWidth = canvas.width / Math.floor(audioData.length / step);
    let xWav = 0;

    for(let i = 0; i < audioData.length; i += step) {
        const y = (audioData[i] + 1) / 2 * canvas.height;
        if(i === 0) ctx.moveTo(xWav, y);
        else ctx.lineTo(xWav, y);
        xWav += sliceWidth;
    }
    ctx.stroke();

    // Pitch History Plot
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 7;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    let isDrawing = false;
    for (let i = 0; i < pitchHistory.length; i++) {
        const pt = pitchHistory[i];
        const x = canvas.width * (1 - (now - pt.time) / HISTORY_DURATION_MS);

        if (pt.pitch === null) {
            isDrawing = false;
            continue;
        }

        const y = canvas.height - canvas.height * ((Math.log2(pt.pitch) - yMinLog) / (yMaxLog - yMinLog));

        if (!isDrawing) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            isDrawing = true;
        } else {
            ctx.lineTo(x, y);
        }

        // Batch the strokes when possible
        if (isDrawing && (i === pitchHistory.length - 1 || pitchHistory[i+1].pitch === null)) {
            ctx.stroke();
        }
    }
}
