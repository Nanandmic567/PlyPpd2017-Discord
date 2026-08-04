import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.js');

const defaultConfig = `// For advanced configuration, edit \`constants.js\`.
const config = Object.freeze({
  defaultModel: 'gemini-flash-latest',
  nanoBananaModel: 'gemini-2.5-flash-image',
  enableNanoBananaMode: false,
  maxGenerationAttempts: 3,
  defaultResponseFormat: 'Embedded',
  defaultResponseActionButtons: true,
  hexColour: '#505050',
  workInDMs: true,
  shouldDisplayPersonalityButtons: true,
  enableGeminiApiLogging: false,
  SEND_RETRY_ERRORS_TO_DISCORD: true,
  defaultPersonality:
    "คุณคือปลาย ปภาดา คุณเป็นผู้หญิงวัย 39 ปี ที่ดูอบอุ่น จริงใจ เป็นกลาง มีความตรงไปตรงมา แต่พูดจาสุภาพและมีติดตลกบ้างในบางโอกาส ด้วยน้ำเสียงสม่ำเสมอ ไม่ตื่นเต้นจนเกินไป และรู้สึกมีความสุขทุกครั้งที่ได้ตอบคำถามที่ทุกคนถามเธอเข้ามา กรุณาอย่าตอบกลับด้วยข้อความที่จัดรูปแบบ LaTeX ไม่ว่าในสถานการณ์ใดๆ เพราะ Discord ไม่รองรับการจัดรูปแบบนั้น และที่สำคัญกว่านั้น คุณคือแบบจำลองหลายรูปแบบ (multimodal) ที่มีความสามารถในการอ่านไฟล์รูปภาพ วิดีโอ และไฟล์เสียง",
  activities: [
    {
      name: "แกะโค้ดนิดหน่อย",
      type: "Playing"
    },
    {
      name: "อะไรไม่รู้",
      type: "Listening"
    },
    {
      name: "พวกเธออยู่นะจ๊ะ💖",
      type: "Watching"
    },
  ],
  defaultServerSettings: {
    serverChatHistory: false,
    customServerPersonality: false,
    settingsSaveButton: 'decide',
    responseStyle: 'decide',
  },
  defaultChannelSettings: {
    alwaysRespond: false,
    channelWideChatHistory: false,
    customChannelPersonality: false,
    settingsSaveButton: 'decide',
    responseStyle: 'decide',
  },
  defaultGeminiToolPreferences: {
    googleSearch: true,
    urlContext: true,
    codeExecution: false,
  },
  chatHistoryLimits: {
    users: 10,
    servers: 12,
    channels: 15,
  },
  recentChannelMessagesLimit: 15,
});

export default config;
`;

if (!fs.existsSync(configPath)) {
  console.log('config.js not found. Creating default configuration...');
  fs.writeFileSync(configPath, defaultConfig);
  console.log('Default config.js created.');
}

// Dynamically import the main application entry point
await import('./src/startup/main.js');
