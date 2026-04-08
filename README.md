# AR OLS Surface Viewer

Web AR app สำหรับดู Obstacle Limitation Surface (OLS) บนมือถือ ผ่าน 3D mesh ที่ render ด้วย Three.js

## โหมดการใช้งาน

### Test Mode (แนะนำสำหรับทดสอบครั้งแรก) ⭐
ติ๊กถูก "โหมดทดสอบ" → surface ทั้งหมดจะ shift centroid มาวางที่ตำแหน่งของ Bolt ตอนนี้ ทดสอบได้ทุกที่ ไม่ต้องไปสนามบิน

### Real Geo Mode
ใช้เมื่ออยู่สนามบินจริง — surface render ตามพิกัดในไฟล์ ต้องอยู่ใกล้ runway ถึงจะเห็น

## ทำไมเวอร์ชันก่อนหน้ามองไม่เห็นอะไรเลย

VTSS OLS surfaces อยู่ห่างมาก:
- Inner Horizontal: 4.3-5.6 km จาก ARP
- Conical: 4.3-7.6 km
- Approach/Take-off: ยาว 16-17 km

ถ้าไม่ได้อยู่ที่สนามบิน → surface ห่าง 10+ km → AR มองไม่เห็น
**+ โค้ดเดิมแสดงเป็น sphere ที่ vertices ไม่ใช่ mesh จริง**

เวอร์ชันใหม่: ใช้ Three.js BufferGeometry + earcut triangulation → render เป็นแผ่น mesh จริงๆ

## Deploy

GitHub Pages: Settings → Pages → Source: main / root → Save → URL จะโผล่หลังจาก 1-2 นาที

## ใช้งานบน Note 10 Lite

1. Chrome → URL ของ app
2. Allow Location + Camera + Motion sensors  
3. เลือก `vtss_ols.geojson`
4. **ติ๊ก "โหมดทดสอบ"** ครั้งแรก
5. กด "เริ่มดู AR"
6. หมุนตัวรอบๆ จะเห็น mesh ลอย

## สีของ surfaces

🔵 Inner Horizontal | 🟣 Conical | 🟢 Approach | 🟠 Take-off | 🌸 Transitional
