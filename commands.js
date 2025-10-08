const commands = [
  {
    name: "respond_to_all",
    description: "ตั้งค่าให้ปลายตอบทุกข้อความในช่องนี้แบบอัตโนมัติค่ะ",
    options: [
      {
        name: "enabled",
        description: "เลือก true เพื่อเปิดใช้งาน หรือ false เพื่อปิดนะคะ",
        type: 5,
        required: true
      }
    ]
  },
  {
    name: "clear_memory",
    description: "ล้างประวัติการคุยของเรากันค่ะ"
  },
  {
    name: "settings",
    description: "เปิดหน้าต่างการตั้งค่าส่วนตัวค่ะ"
  },
  {
    name: "server_settings",
    description: "เปิดหน้าต่างการตั้งค่าสำหรับเซิร์ฟเวอร์นี้ค่ะ"
  },
  {
    name: "blacklist",
    description: "จัดการรายชื่อผู้ใช้ที่ถูกจำกัดการใช้งานค่ะ",
    options: [
      {
        type: 6,
        name: "user",
        description: "เลือกผู้ใช้ที่ต้องการเพิ่มเข้าบัญชีดำนะคะ",
        required: true
      }
    ]
  },
  {
    name: "whitelist",
    description: "นำผู้ใช้ออกจากบัญชีดำค่ะ",
    options: [
      {
        type: 6,
        name: "user",
        description: "เลือกผู้ใช้ที่ต้องการนำออกจากบัญชีดำนะคะ",
        required: true
      }
    ]
  },
  {
    name: "status",
    description: "ดูสถานะการทำงานของปลายตอนนี้ค่ะ (CPU, RAM)"
  },
  {
    name: "toggle_channel_chat_history",
    description: "เปิด/ปิดให้ทุกคนในช่องนี้ใช้ประวัติการแชทร่วมกันค่ะ",
    options: [
      {
        name: "enabled",
        description: "เลือก true เพื่อเปิดใช้งาน หรือ false เพื่อปิดนะคะ",
        type: 5,
        required: true
      },
      {
        name: "instructions",
        description: "ใส่คำสั่งเพิ่มเติมสำหรับช่องนี้ได้เลยค่ะ",
        type: 3,
        required: false
      }
    ]
  }
];

export { commands };
