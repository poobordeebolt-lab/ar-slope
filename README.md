# AR Slope Surface Viewer

AR web app สำหรับ pre-survey obstacle เทียบกับ slope surface บนมือถือ
ใช้งานบน Galaxy Note 10 Lite (Android 13) หรือมือถือใดๆ ที่มี Chrome + GPS + Compass

## คุณสมบัติ

- โหลด slope surface จากไฟล์ GeoJSON (Polygon ที่มีพิกัด X, Y, Z)
- แสดง vertices ของ surface เป็น 3D markers ใน AR camera view
- แสดงตำแหน่ง user (lat/lon/alt) + GPS accuracy แบบ real-time
- คำนวณ clearance ระหว่างตำแหน่ง user กับจุดที่ใกล้ที่สุดบน surface
- เตือนเมื่อตำแหน่งเกิน surface (สำหรับ pre-survey เท่านั้น)
- 100% open source, ไม่มี backend, ไม่ส่งข้อมูลออก

## การ Deploy (GitHub Pages — ฟรี)

1. สร้าง GitHub repo ใหม่ (เช่น `ar-slope`)
2. Upload ไฟล์ทั้ง 3 ไฟล์: `index.html`, `app.js`, `README.md`
3. ไปที่ Settings → Pages → Source: `main` branch, folder: `/ (root)`
4. รอ 1-2 นาที จะได้ URL เช่น `https://username.github.io/ar-slope/`
5. เปิด URL บน Chrome ในมือถือ → อนุญาต Location + Camera + Motion sensors

**สำคัญ:** ต้องเปิดผ่าน HTTPS เท่านั้น (GitHub Pages ใช้ HTTPS อยู่แล้ว) เพราะ browser จะไม่ให้ access camera/GPS บน HTTP

## การใช้งานบน Galaxy Note 10 Lite

1. เปิด Chrome (ไม่ใช่ Samsung Internet เพราะ sensor API support ดีกว่า)
2. เข้า URL ของ app
3. กด "Allow" สำหรับ Location, Camera, Motion sensors
4. เลือกไฟล์ GeoJSON ของ slope surface หรือกด "ใช้ Demo"
5. ออกไปที่โล่ง รอ GPS fix (H-acc < 10 m)
6. หมุนมือถือเลข 8 เพื่อ calibrate compass
7. มองรอบๆ จะเห็นจุด 3D ของ surface vertices ลอยอยู่ในตำแหน่งจริง

## รูปแบบ GeoJSON ที่รองรับ

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "OLS Approach 09" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[
          [100.8024, 17.2384, 55.0],
          [100.8030, 17.2384, 55.0],
          [100.8030, 17.2390, 60.0],
          [100.8024, 17.2390, 60.0],
          [100.8024, 17.2384, 55.0]
        ]]
      }
    }
  ]
}
```

**สำคัญมาก:**
- Coordinates ต้องเป็น `[longitude, latitude, altitude]` ตามลำดับ
- Altitude ต้องเป็น **MSL (mean sea level) เป็นเมตร** เพื่อเทียบกับ GPS altitude ของมือถือได้
- ถ้า slope surface ของคุณอยู่ใน UTM Zone 47N (เช่น VTPO) ต้อง reproject เป็น EPSG:4326 ก่อน

### แปลงจาก UTM 47N เป็น WGS84 ใน QGIS:
1. Right click layer → Export → Save Features As
2. Format: GeoJSON
3. CRS: EPSG:4326 - WGS 84
4. ติ๊ก "Persist layer metadata" ถ้ามี

### แปลงด้วย ogr2ogr (CLI):
```bash
ogr2ogr -f GeoJSON -t_srs EPSG:4326 -s_srs EPSG:32647 \
  output_wgs84.geojson input_utm47n.geojson
```

## ความแม่นยำที่คาดหวังบน Note 10 Lite

Note 10 Lite มี GNSS chip ที่รองรับ GPS L1, GLONASS, Galileo, BeiDou (single-frequency) ดังนั้น:

| Metric | ที่โล่ง (สนามบิน) | ใกล้ตึก |
|---|---|---|
| Horizontal | 3-7 m | 7-15 m |
| Vertical | 5-12 m | 10-20 m |
| Compass heading | ±5-15° (หลัง calibrate) | ±15-30° |

**Visual offset ในภาพ AR ที่ระยะ 50 m:** ~5-15 m
**Visual offset ที่ระยะ 100 m:** ~10-25 m

→ เพียงพอสำหรับ pre-survey "หาเสาน่าสงสัย" แต่ไม่ใช่ค่าตัดสินสุดท้าย

## ข้อจำกัดที่ต้องรู้

1. **Altitude จาก GPS มือถือไม่แม่น** — error มักจะ 5-15 m clearance ที่คำนวณได้จึงใช้แค่เป็น indicator
2. **Compass drift** — ถ้าอยู่ใกล้โลหะหนัก (เครื่องบิน รั้วเหล็ก) heading จะเพี้ยน
3. **AR.js location-based ไม่ใช้ SLAM** — object จะ "ลอย" ตามที่ GPS บอก ไม่ track surface จริง
4. **Chrome เท่านั้น** — Samsung Internet, Firefox อาจมีปัญหากับ DeviceOrientation API
5. **ต้องอยู่ที่โล่ง** — GPS ในอาคาร/ใต้ชายคาจะใช้ไม่ได้

## ขั้นตอนถัดไป (ถ้าต้องการพัฒนาต่อ)

- เพิ่ม triangulated mesh สำหรับ surface แทนที่จะแสดงแค่ vertices (ใช้ Three.js BufferGeometry)
- เพิ่มฟังก์ชันบันทึกตำแหน่งเสาที่น่าสงสัยเป็น GeoJSON เพื่อ export กลับไป QGIS
- เพิ่ม support สำหรับ external GNSS ผ่าน Web Bluetooth (สำหรับอนาคตถ้าซื้อ Reach RX)
- เพิ่ม EGM96 geoid correction สำหรับแปลง ellipsoidal height ↔ MSL

## License

MIT — ใช้ฟรี แก้ไขได้ตามสบาย
