import fs from 'node:fs';
import path from 'node:path';

function parseIFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 28) return null;
    // Windows 10/11 $I 文件结构：
    // offset 0: header (8 bytes)
    // offset 8: file size (8 bytes)
    // offset 16: deleted timestamp (8 bytes)
    // offset 24: file path string (UTF-16LE)
    // Windows 10 扩展：offset 24 为 path length (4 bytes), offset 28 开始为 UTF-16LE
    let origPath = '';
    if (buf.length >= 28) {
      // 尝试从 offset 24 或 28 解析 UTF-16LE 字符串
      const str1 = buf.subarray(24).toString('utf16le').replace(/\0.*$/, '');
      const str2 = buf.subarray(28).toString('utf16le').replace(/\0.*$/, '');
      origPath = str2.length > 2 && (str2[1] === ':' || str2.startsWith('\\')) ? str2 : str1;
    }
    return origPath;
  } catch (e) {
    return null;
  }
}

function scanRecycleBin(root) {
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
          const orig = parseIFile(iPath);
          const rFile = '$R' + file.slice(2);
          const rPath = path.join(sidDir, rFile);
          if (orig && (orig.includes('物业') || orig.includes('发票') || orig.includes('fapiao') || orig.includes('wuye'))) {
            console.log(`[FOUND MATCH!]`);
            console.log(`  Original Path: ${orig}`);
            console.log(`  Recover Data File: ${rPath} (Exists: ${fs.existsSync(rPath)})`);
          } else if (orig && orig.includes('D:\\')) {
            // 输出所有 D 盘被删除的项目供参考
            console.log(`  D-Drive deleted: ${orig} -> ${rPath}`);
          }
        }
      }
    } catch (e) {}
  }
}

console.log('Scanning C:\\$Recycle.Bin...');
scanRecycleBin('C:\\$Recycle.Bin');

console.log('Scanning D:\\$Recycle.Bin...');
scanRecycleBin('D:\\$Recycle.Bin');
