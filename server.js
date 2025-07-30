// server.js (CommonJS version)
const Fastify = require("fastify");
const fastifyWebsocket = require("@fastify/websocket");
const WebSocket = require("ws");
const dotenv = require("dotenv");

dotenv.config();

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const PORT = process.env.PORT || 3000;

const fastify = Fastify();
fastify.register(fastifyWebsocket);

// μ-law to PCM 16-bit conversion
function ulawToPcm16(buffer) {
  const MULAW_BIAS = 33;
  const pcmSamples = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    let muLawByte = buffer[i] ^ 0xff;
    let sign = muLawByte & 0x80;
    let exponent = (muLawByte >> 4) & 0x07;
    let mantissa = muLawByte & 0x0f;
    let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
    sample = sign ? (MULAW_BIAS - sample) : (sample - MULAW_BIAS);
    pcmSamples[i] = sample;
  }
  return Buffer.from(pcmSamples.buffer);
}

// PCM 16-bit to μ-law conversion
function pcm16ToUlaw(buffer) {
  const pcmSamples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  const ulawBuffer = Buffer.alloc(pcmSamples.length);

  for (let i = 0; i < pcmSamples.length; i++) {
    let sample = pcmSamples[i];
    let sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    sample += MULAW_BIAS;
    if (sample > MULAW_MAX) sample = MULAW_MAX;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }

    let mantissa = (sample >> (exponent + 3)) & 0x0f;
    let ulawByte = ~(sign | (exponent << 4) | mantissa);
    ulawBuffer[i] = ulawByte;
  }

  return ulawBuffer;
}

fastify.get("/ws", { websocket: true }, (connection, req) => {
  const exotelSocket = connection.socket;
  console.log("📞 Exotel connected");

  const vapiSocket = new WebSocket("wss://api.vapi.ai/audio-websocket");

  vapiSocket.on("open", () => {
    console.log("🤖 Connected to Vapi");
    vapiSocket.send(JSON.stringify({
      type: "start",
      apiKey: VAPI_API_KEY,
      assistantId: VAPI_ASSISTANT_ID,
      audioConfig: {
        sampleRate: 16000,
        encoding: "LINEAR16",
      }
    }));
  });

  vapiSocket.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "audio") {
        const audioBuffer = Buffer.from(msg.audio, "base64");
        const ulawBuffer = pcm16ToUlaw(audioBuffer);
        exotelSocket.send(ulawBuffer);
      } else {
        console.log("🧠 Vapi:", msg.type);
      }
    } catch (err) {
      console.error("❌ Failed to parse Vapi message:", err);
    }
  });

  exotelSocket.on("message", (data) => {
    const pcmBuffer = ulawToPcm16(data);
    const base64 = pcmBuffer.toString("base64");
    vapiSocket.send(JSON.stringify({
      type: "audio",
      audio: base64
    }));
  });

  exotelSocket.on("close", () => {
    console.log("❎ Exotel disconnected");
    vapiSocket.close();
  });

  vapiSocket.on("close", () => {
    console.log("❎ Vapi disconnected");
    exotelSocket.close();
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error("❌ Server failed to start:", err);
    process.exit(1);
  }
  console.log(`🚀 WebSocket Proxy running at ${address}/ws`);
});
