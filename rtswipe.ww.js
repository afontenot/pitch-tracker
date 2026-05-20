/*
 * Web Worker: RT-SWIPE algorithm
 * Implementation based on Python version by Peter Meier and Sebastian Strahl.
 * https://github.com/groupmm/real_time_swipe/blob/main/src/rtswipe/rtswipe.py
 * License: MIT License (https://opensource.org/licenses/MIT)
 */
class RTSwipe {
    constructor(fs) {
        this.fs = fs;
        this.f_min = 55.0;      // min freq (A1)
        this.f_max = 1760.0;    // max freq (A6)
        this.erb_step = 0.1;    // step size for ERB scale
        this.pitch_res = 12.5;  // pitch resolution in cents
        this.str_thresh = 0.3;  // strength threshold
        this.init();
    }

    hz2erbs(hz) { return 21.4 * Math.log10(1 + hz / 229); }
    erbs2hz(erbs) { return (Math.pow(10, erbs / 21.4) - 1) * 229; }

    init() {
        // Pitch candidates (log spaced)
        this.pcs = [];
        for (let p = Math.log2(this.f_min); p <= Math.log2(this.f_max); p += this.pitch_res / 1200) {
            this.pcs.push(Math.pow(2, p));
        }

        // Window sizes (power of 2 decreasing sizes based on target frequencies)
        const log_ws_max = Math.ceil(Math.log2((8 / this.f_min) * this.fs));
        const log_ws_min = Math.floor(Math.log2((8 / this.f_max) * this.fs));
        this.ws = [];
        for (let p = log_ws_max; p >= log_ws_min; p--) {
            this.ws.push(Math.pow(2, p));
        }
        this.max_ws = Math.max(...this.ws);

        // Multi-resolution weights mapping candidate bins to correct FFT window scopes
        this.mu = Array.from({length: this.ws.length}, () => new Float32Array(this.pcs.length));
        for(let i = 0; i < this.ws.length; i++) {
            for(let j = 0; j < this.pcs.length; j++) {
                let err = Math.abs(Math.log2(8 * this.fs / this.pcs[j]) - Math.log2(this.max_ws));
                let oct = i;
                if(err > oct - 1 && err < oct + 1) {
                    this.mu[i][j] = 1 - Math.abs(err - oct);
                }
            }
        }

        // ERB frequency bands
        this.erb_freqs = [];
        let startErb = this.hz2erbs(this.pcs[0] / 4);
        let endErb = this.hz2erbs(this.fs / 2);
        for (let e = startErb; e <= endErb; e += this.erb_step) {
            this.erb_freqs.push(this.erbs2hz(e));
        }

        // Periodic hanning windows
        this.windows = this.ws.map(N => {
            let win = new Float32Array(N);
            for(let i = 0; i < N; i++) {
                win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (N + 1));
            }
            return win;
        });

        // Compute harmonic correlation kernels
        this.kernels = [];
        for (let j = 0; j < this.pcs.length; j++) {
            let pc = this.pcs[j];
            let num_harmonics = Math.floor(this.erb_freqs[this.erb_freqs.length - 1] / pc - 0.75);
            let k = new Float32Array(this.erb_freqs.length);

            let primes = [1, 2];
            for (let i = 3; i <= num_harmonics; i += 2) {
                let isPrime = true;
                for (let div = 3; div * div <= i; div += 2) {
                    if (i % div === 0) { isPrime = false; break; }
                }
                if (isPrime) primes.push(i);
            }

            let q = this.erb_freqs.map(f => f / pc);
            for (let p_idx = 0; p_idx < primes.length; p_idx++) {
                let prime = primes[p_idx];
                for(let e = 0; e < q.length; e++) {
                    let a = Math.abs(q[e] - prime);
                    if (a < 0.25) {
                        k[e] += Math.cos(2 * Math.PI * q[e]);
                    } else if (a > 0.25 && a < 0.75) {
                        k[e] += Math.cos(2 * Math.PI * q[e]) / 2;
                    }
                }
            }

            // L2 Kernel Norming and square root dampening
            let normSq = 0;
            for(let e = 0; e < q.length; e++) {
                k[e] *= Math.sqrt(1.0 / q[e]);
                if (k[e] > 0) normSq += k[e] * k[e];
            }
            let norm = Math.sqrt(normSq);
            if (norm > 0) {
                for(let e = 0; e < q.length; e++) k[e] /= norm;
            }
            this.kernels.push(k);
        }

        // Pre-allocate FFT processing arrays to avoid memory thrashing during 60FPS polling
        this.fft_real = new Float32Array(this.max_ws);
        this.fft_imag = new Float32Array(this.max_ws);
        this.segment_buf = new Float32Array(this.max_ws);
    }

    // Real-to-Complex FFT optimized to bypass arbitrary sizes
    // (SWIPE uses power-of-2)
    rfftMag(segment) {
        const N = segment.length;
        const real = this.fft_real;
        const imag = this.fft_imag;
        real.fill(0, 0, N);
        imag.fill(0, 0, N);
        for(let i = 0; i < N; i++) real[i] = segment[i];

        let j = 0;
        for(let i = 0; i < N - 1; i++) {
            if(i < j) {
                let tr = real[j]; real[j] = real[i]; real[i] = tr;
            }
            let m = N >> 1;
            while(j >= m) { j -= m; m >>= 1; }
            j += m;
        }

        for(let mmax = 1; mmax < N; mmax <<= 1) {
            let istep = mmax << 1;
            let theta = -Math.PI / mmax;
            let wtemp = Math.sin(0.5 * theta);
            let wpr = -2.0 * wtemp * wtemp;
            let wpi = Math.sin(theta);
            let wr = 1.0, wi = 0.0;
            for(let m = 0; m < mmax; m++) {
                for(let i = m; i < N; i += istep) {
                    let j = i + mmax;
                    let tr = wr * real[j] - wi * imag[j];
                    let ti = wr * imag[j] + wi * real[j];
                    real[j] = real[i] - tr;
                    imag[j] = imag[i] - ti;
                    real[i] += tr;
                    imag[i] += ti;
                }
                let wtemp_val = wr;
                wr = wr * wpr - wi * wpi + wr;
                wi = wi * wpr + wtemp_val * wpi + wi;
            }
        }

        const mag = new Float32Array(N / 2 + 1);
        for(let i = 0; i <= N / 2; i++) {
            mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        }
        return mag;
    }

    process(full_buffer) {
        let X_erb = [];
        for (let idx = 0; idx < this.ws.length; idx++) {
            let N = this.ws[idx];
            let segment = this.segment_buf.subarray(0, N);
            let startIdx = Math.max(0, full_buffer.length - N);

            // Window latest available audio buffer segment
            for (let i = 0; i < N; i++) {
                segment[i] = full_buffer[startIdx + i] * this.windows[idx][i];
            }

            let mag = this.rfftMag(segment);
            let x_erb_row = new Float32Array(this.erb_freqs.length);

            // Map to ERB Frequencies linearly
            for(let e = 0; e < this.erb_freqs.length; e++) {
                let f = this.erb_freqs[e];
                let k_exact = f * N / this.fs;
                let k1 = Math.floor(k_exact);
                let k2 = k1 + 1;
                if (k1 < 0) { x_erb_row[e] = mag[0]; }
                else if (k2 >= mag.length) { x_erb_row[e] = mag[mag.length - 1]; }
                else {
                    let frac = k_exact - k1;
                    x_erb_row[e] = mag[k1] * (1 - frac) + mag[k2] * frac;
                }
                // warp root spectrum
                x_erb_row[e] = Math.sqrt(Math.max(x_erb_row[e], 0));
            }

            // Normalize to unit length
            let normSq = 0;
            for(let e = 0; e < this.erb_freqs.length; e++) normSq += x_erb_row[e] * x_erb_row[e];
            let norm = Math.sqrt(normSq);
            if (norm === 0) norm = 1;
            for(let e = 0; e < this.erb_freqs.length; e++) x_erb_row[e] /= norm;

            X_erb.push(x_erb_row);
        }

        // Correlator
        let S = new Float32Array(this.pcs.length);
        let max_S = -Infinity;
        let best_j = 0;

        for (let j = 0; j < this.pcs.length; j++) {
            for (let idx = 0; idx < this.ws.length; idx++) {
                if (this.mu[idx][j] === 0) continue; // Early skip to bypass out-of-bounds octaves
                let dot = 0;
                for (let e = 0; e < this.erb_freqs.length; e++) {
                    dot += X_erb[idx][e] * this.kernels[j][e];
                }
                S[j] += dot * this.mu[idx][j];
            }
            if (S[j] > max_S) { max_S = S[j]; best_j = j; }
        }

        // Sub-Octave Prioritization Heuristic.
        // If a pitch EXACTLY one octave below the winner is highly correlated
        // (at least 80% as strong as the max score), we assume the max score is
        // just a bright 2nd harmonic, and shift to the true fundamental.
        const steps_per_octave = Math.round(1200 / this.pitch_res);
        const sub_octave_j = best_j - steps_per_octave;
        if (sub_octave_j >= 0 && S[sub_octave_j] > 0.8 * max_S) {
            best_j = sub_octave_j;
            max_S = S[sub_octave_j];
        }

        let pitch = NaN;
        if (max_S > this.str_thresh) {
            if (best_j === 0) pitch = this.pcs[0];
            else if (best_j === this.pcs.length - 1) pitch = this.pcs[this.pcs.length - 1];
            else {
                // Parabolic Interpolation for accurate centering
                let p0 = this.pcs[best_j - 1], p1 = this.pcs[best_j], p2 = this.pcs[best_j + 1];
                let tc0 = 1 / p0, tc1 = 1 / p1, tc2 = 1 / p2;
                let ntc0 = (tc0 / tc1 - 1) * 2 * Math.PI;
                let ntc2 = (tc2 / tc1 - 1) * 2 * Math.PI;

                let s0 = S[best_j - 1], s1 = S[best_j], s2 = S[best_j + 1];
                let d0 = s0 - s1;
                let d2 = s2 - s1;
                let den = ntc0 * ntc0 * ntc2 - ntc2 * ntc2 * ntc0;

                if (Math.abs(den) > 1e-12) {
                    let A = (d0 * ntc2 - d2 * ntc0) / den;
                    let B = (d2 * ntc0 * ntc0 - d0 * ntc2 * ntc2) / den;

                    if (A < 0) {
                        let x_max = -B / (2 * A);
                        if (x_max >= Math.min(ntc0, ntc2) && x_max <= Math.max(ntc0, ntc2)) {
                            pitch = 1 / ((x_max / (2 * Math.PI) + 1) * tc1);
                        } else pitch = p1;
                    } else pitch = p1;
                } else pitch = p1;
            }
        }
        return { pitch, strength: max_S };
    }
}

// Set up the message listener for the worker
let swipeInst;
self.onmessage = function(e) {
    if (e.data.type === 'init') {
        swipeInst = new RTSwipe(e.data.sampleRate);
        self.postMessage({ type: 'ready' });
    } else if (e.data.type === 'process') {
        const res = swipeInst.process(e.data.audioData);
        self.postMessage({ type: 'result', pitch: res.pitch });
    }
};
