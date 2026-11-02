import { Command, Option } from 'commander';
import { runLint } from './commands/lint.ts';
import { runExport, runNormalize } from './commands/export.ts';
import { runIndex } from './commands/index-cmd.ts';
import { runFixLinks } from './commands/fix-links.ts';

export const VERSION = '0.1.0';

export function buildProgram(): Command {
  const program = new Command();
  program.name('nitrogen').description('Nitrogen (N2): a GitHub-backed wiki with a Claude MCP server').version(VERSION);
  const root = new Option('-r, --root <dir>', 'notes repo root').default(process.cwd());
  const profile = new Option('-p, --profile <profile>', 'normalization profile').choices(['gfm', 'commonmark']).default('gfm');
  const fm = new Option('--frontmatter <mode>', 'frontmatter handling').choices(['keep', 'strip', 'inline']);

  program
    .command('lint')
    .description('Lint pages against the CFM spec')
    .argument('[paths...]', 'pages or folders (default: all)')
    .addOption(root)
    .addOption(new Option('-f, --format <format>').choices(['text', 'json']).default('text'))
    .option('--errors-only', 'hide warnings')
    .action((paths: string[], o) => {
      process.exitCode = runLint(paths, { root: o.root, format: o.format, errorsOnly: o.errorsOnly });
    });

  program
    .command('normalize')
    .description('Print one page as standard markdown')
    .argument('<file>', 'page path relative to the root')
    .addOption(root)
    .addOption(profile)
    .addOption(fm)
    .option('--ledger', 'print the loss ledger to stderr')
    .action((file: string, o) => {
      process.exitCode = runNormalize(file, o);
    });

  program
    .command('export')
    .description('Export the vault (or a folder) to standard markdown')
    .addOption(root)
    .addOption(profile)
    .addOption(fm)
    .requiredOption('-o, --out <dir>', 'output directory')
    .option('--path <prefix>', 'only export this page or folder')
    .option('--keep-image-size', 'emit <img width> for sized images (gfm only)')
    .addOption(new Option('--captions <mode>').choices(['title', 'visible']))
    .option('--no-images', 'do not copy images')
    .action((o) => {
      process.exitCode = runExport({ ...o, out: o.out });
    });

  program
    .command('index')
    .description('Build index rows with the full parser; print, write, or post them to a Worker')
    .addOption(root)
    .option('--out <file>', 'write rows to a JSON file')
    .option('--post <url>', 'POST batches to <url>/admin/ingest (HMAC signed)')
    .option('--secret <secret>', 'ingest secret (prefer NITROGEN_INGEST_SECRET)')
    .option('--batch-size <n>', 'pages per batch', (v) => Number(v), 25)
    .action(async (o) => {
      process.exitCode = await runIndex(o);
    });

  program
    .command('fix-links')
    .description('Move a page and rewrite every link that points at it')
    .addOption(root)
    .requiredOption('--move <paths...>', 'from and to paths')
    .option('--dry-run', 'show the plan only')
    .action((o) => {
      if (o.move.length !== 2) {
        console.error('--move takes exactly two paths: --move old.md new.md');
        process.exitCode = 2;
        return;
      }
      process.exitCode = runFixLinks({ root: o.root, move: [o.move[0], o.move[1]], dryRun: o.dryRun });
    });

  return program;
}
