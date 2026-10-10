import fs from 'node:fs';
import path from 'node:path';

function parseIFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 28) return null;
    let origPath = '';
    const str1 = buf.subarray(24).toString('utf16le').replace(/\0.*$/, '');
    const str2 = buf.subarray(28).toString('utf16le').replace(/\0.*$/, '');
    origPath = str2.length > 2 && (str2[1] === ':' || str2.startsWith('\\')) ? str2 : str1;

    // 读取 Windows FILETIME (offset 16, 8 bytes)
    const filetime = buf.readBigInt64LE(16);
    // 转换为 JS Date (FILETIME 是从 1601-01-01 开始的 100ns 计数)
    const unixTimestamp = Number((filetime - 116444736000000000n) / 10000n);
    const date = new Date(unixTimestamp);

    return { origPath, date };
  } catch (e) {
    return null;
  }
}

function scanRecent(root) {
  if (!fs.existsSync(root)) return;
  const sids = fs.readdirSync(root);
  for (const sid of sids) {
    const sidDir = path.join(root, sid);
    try {
      const stat = fs.statSync(sidDir);
      if (!stat.isDirectory()) continue;
      const files = fs.readdirSync(sidDir);
      for (const file of files) {
        if (file.startsWith('$I')) {
          const iPath = path.join(sidDir, file);
          const parsed = parseIFile(iPath);
          if (!parsed) continue;
          const { origPath, date } = parsed;
          const rFile = '$R' + file.slice(2);
          const rPath = path.join(sidDir, rFile);

          // 打印今天或最近或者包含关键词的项目
          console.log(`[${date.toLocaleString()}] ${origPath} -> ${rPath} (exists: ${fs.existsSync(rPath)})`);
        }
      }
    } catch (e) {}
  }
}

console.log('=== D:\\$Recycle.Bin 最近项目 ===');
scanRecent('D:\\$Recycle.Bin');
