require('dotenv').config();
const mqtt = require('mqtt');
const axios = require('axios');

// URL API Laravel
const SETTINGS_API = process.env.MQTT_SETTINGS_API;
const STORE_API    = process.env.MQTT_STORE_API;

// Cache settings dan lastSaved
let settings = [];
let lastSaved = {};  // { "topic-serialNumber": lastTimestamp }
let clients = {};    // { "deviceId": mqttClient }

// Ambil setting dari Laravel
async function loadSettings() {
  try {
    const res = await axios.get(SETTINGS_API);
    const newSettings = res.data.settings || [];
    console.log(`✅ Settings loaded: ${newSettings.length} records`);

    newSettings.forEach(s => {
      if (!s.device) return;

      const key = `${s.topic}-${s.device.serial_number}`;
      const deviceId = s.device.id;

      // Buat client baru jika belum ada
      if (!clients[deviceId]) {
        const brokerUrl = `mqtt://${s.device.broker_ip}:${s.device.broker_port}`;
        const client = mqtt.connect(brokerUrl);

        client.on('connect', () => {
          console.log(`✅ Connected to MQTT broker ${brokerUrl} for device ${s.device.serial_number}`);
          client.subscribe(s.topic, err => {
            if (err) console.error('❌ Error subscribe', s.topic, err.message);
            else console.log(`📡 Subscribed to topic: ${s.topic} for device ${s.device.serial_number}`);
          });
        });

        client.on('error', err => {
          console.error(`❌ MQTT Error for device ${s.device.serial_number}:`, err.message);
        });

        client.on('message', async (topic, message) => {
          handleMessage(s, topic, message);
        });

        clients[deviceId] = client;
      }
    });

    settings = newSettings;
  } catch (err) {
    console.error('❌ Gagal load settings:', err.message);
  }
}

// Handle message payload
async function handleMessage(setting, topic, message) {
  const payload = message.toString();
  console.log(`📥 ${topic} => ${payload}`);

  const parts = payload.split(',');
  if (parts.length < 5) return console.warn('⚠️ Payload tidak valid, skip');

  const serialNumber = parts[0].trim();
  const temperature  = parseFloat(parts[1].trim());
  const humidity     = parseFloat(parts[2].replace('%', '').trim());
  const noise        = parseFloat(parts[3].trim());
  const tsString     = parts[4].trim();
  const payloadTime  = new Date(tsString).getTime();
  if (!payloadTime) return;

  // Cek apakah topic & serialNumber sesuai setting
  if (serialNumber !== setting.device.serial_number || topic !== setting.topic) return;

  const key = `${topic}-${serialNumber}`;
  const interval = setting.interval || 5;

  if (lastSaved[key] && payloadTime - lastSaved[key] < interval * 1000) return;

  try {
    await axios.post(STORE_API, {
      topic,
      payload,
      device_id: setting.device_id,
      temperature,
      humidity,
      noise,
      timestamp: tsString
    });
    console.log(`✅ Data posted for ${serialNumber}`);
    lastSaved[key] = payloadTime;
  } catch (err) {
    console.error('❌ Error posting to Laravel:', err.message);
  }
}

// Load settings pertama kali
loadSettings();
// Refresh tiap 60 detik
setInterval(loadSettings, 60000);
