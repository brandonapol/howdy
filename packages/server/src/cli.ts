import { join } from "node:path";
import { loadConfig } from "./config.js";
import { backup, listBackups, restore } from "./backup.js";

const config = loadConfig();
const [command, argument] = process.argv.slice(2);
const defaultDir = join(config.root, "backups");

const usage = () => {
  process.stdout.write(
    [
      "howdy backup [dir]     write a snapshot (default: ~/.howdy/backups)",
      "howdy restore <file>   restore a snapshot over this installation",
      "howdy backups [dir]    list snapshots",
      "",
    ].join("\n"),
  );
};

switch (command) {
  case "backup": {
    const archive = await backup(config, argument ?? defaultDir);
    process.stdout.write(`${archive}\n`);
    break;
  }
  case "restore": {
    if (argument === undefined) {
      process.stderr.write("restore needs an archive path\n");
      process.exit(1);
    }
    restore(config, argument);
    process.stdout.write(`restored ${argument} into ${config.root}\n`);
    break;
  }
  case "backups": {
    const found = listBackups(argument ?? defaultDir);
    process.stdout.write(found.length === 0 ? "no backups\n" : `${found.join("\n")}\n`);
    break;
  }
  default:
    usage();
    process.exit(command === undefined ? 0 : 1);
}
