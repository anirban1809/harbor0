import { app } from 'electron';

// `harbor0 webdav …` runs the WebDAV server in the terminal; anything else opens the app.
// Packaged apps get their arguments after the executable, development runs after `electron .`.
const args = process.argv.slice(app.isPackaged ? 1 : 2);
if (args[0] === 'webdav')
  void import('./webdav-cli').then(({ runWebdavCli }) => runWebdavCli(args.slice(1)));
else void import('./main');
