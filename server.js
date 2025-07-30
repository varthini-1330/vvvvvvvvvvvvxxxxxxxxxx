const Fastify = require("fastify");
const fastifyWebsocket = require("@fastify/websocket");
const WebSocket = require("ws");
const dotenv = require("dotenv");
dotenv.config();

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

const fastify = Fastify();
fastify.register(fastifyWebsocket);

// μ-law to PCM 16-bit
function ulawToPcm16(buffer) {
  const MULAW_BIAS = 33;
  const pcmSamples = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    let muLawByte = buffer[i] ^ 0xff;
    let sign = muLawByte & 0x80;
    let exponent = (muLawByte >> 4) & 0x07;
    let mantissa = muLawByte & 0x0f;
    let sample = ((mantissa << 4) + 8) << (exponent + 3);
    sample = sign ? MULAW_BIAS - sample : sample - MULAW_BIAS;
    pcmSamples[i] = sample;
  }
  return Buffer.from(pcmSamples.buffer);
}

// PCM to μ-law
function pcm16ToUlaw(buffer) {
  const MULAW_BIAS = 33;
  const MULAW_MAX = 0x1FFF;
  const pcmSamples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
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

  const vapiSocket = new WebSocket(`wss://api.vapi.ai/ws`);

  vapiSocket.on("open", () => {
    console.log("🤖 Connected to Vapi");
    vapiSocket.send(JSON.stringify({
      type: "start",
      apiKey: VAPI_API_KEY,
      assistantId: VAPI_ASSISTANT_ID
    }));
  });

  vapiSocket.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "start_ack") {
        console.log("✅ Vapi ready");
      } else if (msg.type === "audio") {
        const audioBuffer = Buffer.from(msg.audio, "base64");
        const ulawBuffer = pcm16ToUlaw(audioBuffer);
        exotelSocket.send(ulawBuffer);
      } else {
        console.log("📨 Vapi message:", msg);
      }
    } catch (err) {
      console.error("Invalid Vapi message", err);
    }
  });

  exotelSocket.on("message", (data) => {
    try {
      const pcmBuffer = ulawToPcm16(data);
      const base64 = pcmBuffer.toString("base64");
      vapiSocket.send(JSON.stringify({ type: "audio", audio: base64 }));
    } catch (err) {
      console.error("❌ Error converting or sending audio", err);
    }
  });

  exotelSocket.on("close", () => {
    console.log("📴 Exotel disconnected");
    vapiSocket.close();
  });

  vapiSocket.on("close", () => {
    console.log("📴 Vapi disconnected");
    exotelSocket.close();
  });
});

fastify.listen({ port: 3000 }, () => {
  console.log("🚀 WebSocket Proxy running at ws://localhost:3000/ws");
});