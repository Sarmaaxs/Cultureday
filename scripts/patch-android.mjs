import fs from 'node:fs';
import path from 'node:path';
const manifest = path.resolve('android/app/src/main/AndroidManifest.xml');
if (!fs.existsSync(manifest)) throw new Error('AndroidManifest.xml not found after Capacitor setup.');
let xml = fs.readFileSync(manifest, 'utf8');
if (!xml.includes('android.permission.CAMERA')) {
  xml = xml.replace('<manifest ', '<manifest ').replace(/(<manifest[^>]*>)/, '$1\n    <uses-permission android:name="android.permission.CAMERA" />');
}
xml = xml.replace(/android:label="[^"]*"/, 'android:label="Culture Day"');
xml = xml.replace(/android:icon="@[^"]+"/, 'android:icon="@drawable/culture_day_icon"');
fs.writeFileSync(manifest, xml);
const drawableDir = path.resolve('android/app/src/main/res/drawable');
fs.mkdirSync(drawableDir, { recursive: true });
fs.writeFileSync(path.join(drawableDir, 'culture_day_icon.xml'), `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#FF000000" android:pathData="M0,0h108v108h-108z"/>
  <path android:fillColor="#FFFFFFFF" android:pathData="M29,35h50a5,5 0,0 1,5 5v28a5,5 0,0 1,-5 5h-50a5,5 0,0 1,-5 -5v-28a5,5 0,0 1,5 -5z"/>
  <path android:fillColor="#FF000000" android:pathData="M49,35h10v38h-10z"/>
</vector>`);
console.log('Android camera permission and monochrome app icon configured.');
