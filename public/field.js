/**
 * Voice field — progressive. The page works if this file or #field is removed.
 * Idle drift → live frequency bins → contract into the listing card.
 */
(function () {
  "use strict";

  var canvas = document.getElementById("field");
  if (!canvas || !canvas.getContext) return;

  var reduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    document.documentElement.classList.add("is-static");
    return;
  }

  var gl = null;
  var ctx2d = null;
  var program = null;
  var raf = 0;
  var mode = "idle";
  var analyser = null;
  var freq = new Uint8Array(32);
  var bands = [0, 0, 0, 0, 0, 0, 0, 0];
  var amp = 0;
  var contract = 0;
  var targetContract = 0;
  var card = { x: 0, y: 0, w: 0, h: 0 };
  var start = performance.now();
  var lastT = 0;
  var slow = 0;
  var dead = false;
  var uniforms = {};

  var VERT =
    "attribute vec2 a_pos; void main(){ gl_Position=vec4(a_pos,0.0,1.0); }";

  var FRAG = [
    "precision mediump float;",
    "uniform vec2 u_res;",
    "uniform float u_time;",
    "uniform float u_amp;",
    "uniform vec4 u_lo;",
    "uniform vec4 u_hi;",
    "uniform float u_contract;",
    "uniform vec4 u_card;",
    "void main(){",
    "  vec2 uv = gl_FragCoord.xy / u_res;",
    "  vec2 p = uv * vec2(7.0, 11.0);",
    "  float warp = 0.07 + u_amp * 0.55;",
    "  p.x += sin(u_time * 0.31 + uv.y * 4.0) * warp;",
    "  p.y += cos(u_time * 0.22 + uv.x * 3.0) * warp * 0.6;",
    "  vec2 g = abs(fract(p) - 0.5);",
    "  float d = abs(g.x + g.y - 0.5);",
    "  float line = smoothstep(0.09, 0.02, d);",
    "  vec2 c = uv - vec2(0.62, 0.58);",
    "  float dist = length(c);",
    "  float pulse = 0.0;",
    "  pulse += sin(dist * 14.0 - u_time * 2.4) * u_lo.x;",
    "  pulse += sin(dist * 18.0 - u_time * 2.1) * u_lo.y;",
    "  pulse += sin(dist * 22.0 - u_time * 1.8) * u_lo.z;",
    "  pulse += sin(dist * 28.0 - u_time * 1.5) * u_lo.w;",
    "  pulse += sin(dist * 34.0 - u_time * 1.9) * u_hi.x;",
    "  pulse += sin(dist * 40.0 - u_time * 2.2) * u_hi.y;",
    "  vec3 ink = vec3(0.102, 0.063, 0.031);",
    "  vec3 terra = vec3(0.886, 0.290, 0.086);",
    "  vec3 gold = vec3(0.788, 0.635, 0.153);",
    "  vec3 paper = vec3(0.937, 0.902, 0.824);",
    "  vec3 col = mix(ink, terra, line * (0.28 + u_amp * 0.9));",
    "  col = mix(col, gold, clamp(pulse * 0.22, 0.0, 0.55));",
    "  col += terra * u_amp * (1.0 - dist) * 0.35;",
    "  vec2 fp = gl_FragCoord.xy;",
    "  vec2 c0 = u_card.xy;",
    "  vec2 c1 = u_card.xy + u_card.zw;",
    "  vec2 od = max(c0 - fp, fp - c1);",
    "  float outside = length(max(od, 0.0)) + min(max(od.x, od.y), 0.0);",
    "  float edge = mix(220.0, 10.0, u_contract);",
    "  float cardMask = 1.0 - smoothstep(0.0, edge, outside);",
    "  col = mix(col, paper, u_contract * cardMask);",
    "  col = mix(col, ink * 0.55, u_contract * (1.0 - cardMask) * 0.85);",
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  function degrade() {
    if (dead) return;
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    document.documentElement.classList.add("is-static");
    canvas.style.display = "none";
  }

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function initGL() {
    try {
      gl = canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "low-power"
      });
    } catch (e) {
      gl = null;
    }
    if (!gl) return false;
    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    uniforms.res = gl.getUniformLocation(program, "u_res");
    uniforms.time = gl.getUniformLocation(program, "u_time");
    uniforms.amp = gl.getUniformLocation(program, "u_amp");
    uniforms.lo = gl.getUniformLocation(program, "u_lo");
    uniforms.hi = gl.getUniformLocation(program, "u_hi");
    uniforms.contract = gl.getUniformLocation(program, "u_contract");
    uniforms.card = gl.getUniformLocation(program, "u_card");
    return true;
  }

  function init2d() {
    ctx2d = canvas.getContext("2d", { alpha: false });
    return !!ctx2d;
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.max(1, window.innerWidth);
    var h = Math.max(1, window.innerHeight);
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function readAudio() {
    if (!analyser) {
      amp *= 0.92;
      for (var i = 0; i < 8; i++) bands[i] *= 0.94;
      if (mode === "idle") {
        var t = (performance.now() - start) / 1000;
        amp = 0.08 + Math.sin(t * 0.7) * 0.04;
      }
      return;
    }
    if (freq.length !== analyser.frequencyBinCount) {
      freq = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(freq);
    var n = freq.length;
    var chunk = Math.max(1, Math.floor(n / 8));
    var sum = 0;
    for (var b = 0; b < 8; b++) {
      var acc = 0;
      var startI = b * chunk;
      var endI = b === 7 ? n : startI + chunk;
      for (var k = startI; k < endI; k++) acc += freq[k];
      var v = acc / (255 * (endI - startI));
      bands[b] = bands[b] * 0.55 + v * 0.45;
      sum += bands[b];
    }
    amp = amp * 0.5 + (sum / 8) * 0.5;
  }

  function drawGL(t) {
    gl.uniform2f(uniforms.res, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, t);
    gl.uniform1f(uniforms.amp, amp);
    gl.uniform4f(uniforms.lo, bands[0], bands[1], bands[2], bands[3]);
    gl.uniform4f(uniforms.hi, bands[4], bands[5], bands[6], bands[7]);
    gl.uniform1f(uniforms.contract, contract);
    var dpr = canvas.width / Math.max(1, window.innerWidth);
    gl.uniform4f(
      uniforms.card,
      card.x * dpr,
      canvas.height - (card.y + card.h) * dpr,
      card.w * dpr,
      card.h * dpr
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function draw2d(t) {
    var w = canvas.width;
    var h = canvas.height;
    ctx2d.fillStyle = "#1a1008";
    ctx2d.fillRect(0, 0, w, h);
    var cols = 8;
    var rows = 12;
    var cw = w / cols;
    var ch = h / rows;
    ctx2d.lineWidth = Math.max(2, w * 0.004);
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var b = bands[(x + y) % 8];
        var s = 0.35 + amp * 0.5 + b * 0.5;
        var cx = (x + 0.5) * cw + Math.sin(t * 0.6 + y) * 8 * (0.2 + amp);
        var cy = (y + 0.5) * ch;
        ctx2d.strokeStyle =
          "rgba(226,74,22," + (0.25 + amp * 0.7).toFixed(3) + ")";
        ctx2d.beginPath();
        ctx2d.moveTo(cx, cy - ch * 0.38 * s);
        ctx2d.lineTo(cx + cw * 0.38 * s, cy);
        ctx2d.lineTo(cx, cy + ch * 0.38 * s);
        ctx2d.lineTo(cx - cw * 0.38 * s, cy);
        ctx2d.closePath();
        ctx2d.stroke();
      }
    }
    if (contract > 0.02 && card.w) {
      var dpr = canvas.width / Math.max(1, window.innerWidth);
      ctx2d.fillStyle = "rgba(239,230,210," + contract.toFixed(3) + ")";
      ctx2d.fillRect(card.x * dpr, card.y * dpr, card.w * dpr, card.h * dpr);
    }
  }

  function tick(now) {
    if (dead) return;
    var dt = lastT ? now - lastT : 16;
    lastT = now;
    if (dt > 40) slow++;
    else slow = Math.max(0, slow - 1);
    if (slow > 24) {
      degrade();
      return;
    }
    readAudio();
    contract += (targetContract - contract) * 0.08;
    resize();
    var t = (now - start) / 1000;
    if (gl) drawGL(t);
    else draw2d(t);
    raf = requestAnimationFrame(tick);
  }

  if (!initGL()) {
    gl = null;
    if (!init2d()) {
      degrade();
      return;
    }
  }
  resize();
  raf = requestAnimationFrame(tick);
  window.addEventListener("resize", resize, { passive: true });

  window.MbokaField = {
    setMode: function (next) {
      mode = next || "idle";
      if (mode !== "crystal") targetContract = 0;
    },
    setAnalyser: function (node) {
      analyser = node || null;
      if (analyser && !analyser.frequencyBinCount) analyser = null;
    },
    crystallise: function (rect) {
      mode = "crystal";
      targetContract = 1;
      if (rect) {
        card.x = rect.left;
        card.y = rect.top;
        card.w = rect.width;
        card.h = rect.height;
      }
    },
    degrade: degrade
  };
})();
