# VTSS AR Pre-Survey

Web AR สำหรับ pre-survey obstacle ที่สนามบิน VTSS โดยซ้อน OCS/OLS surface ลงบนภาพกล้องโทรศัพท์ พร้อมคำนวณระยะห่างจาก surface ที่ตำแหน่งผู้ใช้ปัจจุบัน

## คุณสมบัติ

- Render OCS (Area 2A/B/C/D) และ OLS (Inner Horizontal, Conical, Approach, Take-off, Transitional) เป็น 3D mesh จาก GeoJSON 3D ที่ใช้ ellipsoidal height
- ใช้ Geolocation API (GPS) + DeviceOrientation API (IMU) เพื่อวางกล้องในพิกัด ENU รอบตำแหน่งผู้ใช้
- คำนวณ clearance จาก surface ที่ต่ำที่สุดที่คลุมตำแหน่งปัจจุบัน (+ คือใต้ surface ปลอดภัย, − คือ penetrate)
- ปรับ opacity, range, toggle OLS/OCS ได้
- Deploy อัตโนมัติผ่าน GitHub Pages

## โครงสร้าง

```
.
├── index.html
├── style.css
├── js/
│   ├── app.js         # main loop
│   ├── geodesy.js     # WGS84 -> ENU
│   ├── surfaces.js    # geojson -> three.js mesh + point-in-polygon
│   └── sensors.js     # GPS + orientation
├── data/
│   ├── vtss_ocs.geojson
│   └── vtss_ols.geojson
└── .github/workflows/deploy.yml
```

## Deploy บน GitHub Pages

1. สร้าง repo ใหม่บน GitHub (เช่น `vtss-ar`)
2. Push โค้ดทั้งหมดนี้ขึ้น branch `main`
3. ไปที่ **Settings → Pages** แล้วเลือก Source = **GitHub Actions**
4. Workflow `.github/workflows/deploy.yml` จะ build อัตโนมัติ URL จะอยู่ที่ `https://<user>.github.io/vtss-ar/`

### คำสั่ง git เริ่มต้น

```bash
cd vtss-ar
git init
git add .
git commit -m "initial VTSS AR"
git branch -M main
git remote add origin https://github.com/<user>/vtss-ar.git
git push -u origin main
```

## การใช้งานบน Android 13

1. เปิด **Chrome** (ไม่ใช่ in-app browser) ไปที่ URL GitHub Pages
2. ต้องเป็น **HTTPS** (GitHub Pages ให้อยู่แล้ว) มิฉะนั้นกล้อง + GPS จะไม่ทำงาน
3. แตะ **เริ่มกล้อง + GPS** → อนุญาตสิทธิ์ Camera และ Location
4. รอ GPS fix สัก 5–10 วินาที แล้วขยับดูรอบตัว
5. หาก heading เพี้ยน เล็งโทรศัพท์ไปทางทิศเหนือจริงแล้วกด **Calibrate Heading**
6. HUD จะบอก surface ที่คลุมตำแหน่งปัจจุบัน + clearance เป็นเมตร

## หมายเหตุทางเทคนิค

**พิกัดสูง** — GeoJSON ใช้ WGS84 ellipsoidal height ตรงกับที่ `navigator.geolocation` คืนมาบน Android (`coords.altitude` เป็น ellipsoidal height บนอุปกรณ์ที่รองรับ GNSS raw) จึงเปรียบเทียบตรงๆ ได้ ไม่ต้องปรับ geoid (EGM96) เพิ่ม

**พิกัด ENU** — ทุก frame จะแปลง ECEF → ENU รอบตำแหน่งปัจจุบัน ถ้าเดินเกิน 200 m จากจุดตั้ง mesh จะ rebuild เพื่อลด floating-point error

**Heading accuracy** — magnetometer บนมือถือไม่แม่นยำเท่า survey GNSS (±5–15°) ควรใช้ปุ่ม Calibrate Heading โดยอ้างอิงจากจุดที่ทราบ bearing แน่ (เช่น runway centerline, landmark สองจุด)

**GPS accuracy** — `coords.accuracy` แสดงอยู่ใน HUD ถ้า > 10 m ควรตีความ clearance ด้วยความระมัดระวัง สำหรับ pre-survey เบื้องต้นก็ยอมรับได้ แต่การตัดสิน penetration จริงควรใช้ RTK/Total Station

**Triangulation** — ใช้ fan triangulation จาก outer ring พอสำหรับ polygon ของ Annex 14 ที่เกือบ convex (trapezoid/quad) ถ้าต้องการรองรับ polygon ที่ซับซ้อนจริงๆ ให้เพิ่ม earcut.js

**WebXR** — โค้ดนี้ใช้ `getUserMedia` + manual camera matrix ไม่ใช่ WebXR เพื่อให้ใช้ได้บน Android Chrome ทั่วไปโดยไม่ต้องเปิด flag

## ข้อจำกัดที่ควรรู้

- ไม่มี occlusion จริง — surface จะลอยทับทุกอย่างในภาพ ถ้าต้องการ depth occlusion จริงต้องใช้ WebXR Depth API (รองรับเฉพาะบางอุปกรณ์)
- ไม่มี SLAM — ตำแหน่ง 3D อ้างอิงจาก GPS ล้วน ซึ่ง jitter หลายเมตร สำหรับ visual pre-survey ก็พอ แต่อย่าใช้ตัดสินทาง legal
- รองรับเฉพาะ Polygon/MultiPolygon 3D (ไม่รับ LineString/Point)
