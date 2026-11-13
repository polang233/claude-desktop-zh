import fs from 'node:fs';
import os from 'node:os';

// macOS 的临时目录经过 /var 链接；夹具使用真实路径，保留产品对链接的拒绝检查。
if (process.platform === 'darwin') process.env.TMPDIR = fs.realpathSync(os.tmpdir());
