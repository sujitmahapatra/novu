#!/usr/bin/env node

import meow from 'meow';
import os from 'os';
import { basename, dirname, join, relative } from 'path';
import { create as createTar } from 'tar';
import { globby } from 'globby';
import { parsePackageSelector, readProjects } from '@pnpm/filter-workspace-packages';
import { pipe as rawPipe } from 'mississippi';
import { promises as fs } from 'fs';
import { promisify } from 'util';

const pipe = promisify(rawPipe);
const SCRIPT_PATH = basename(process.argv[1]);

const cli = meow(
  `
  Usage
    $ ${SCRIPT_PATH} [--patterns=regex]... [--list-files] <Dockerfile-path>

  Options
    --list-files, -l    Don't generate tar, just list files. Useful for debugging.
    --patterns, -p      Additional .gitignore-like patterns used to find/exclude files (can be specified multiple times).
    --root              Path to the root of the monorepository. Defaults to current working directory.

  Examples
    $ ${SCRIPT_PATH} packages/app/Dockerfile
`,
  {
    allowUnknownFlags: false,
    autoHelp: false,
    description: `./${SCRIPT_PATH}`,
    flags: {
      help: { type: 'boolean', alias: 'h' },
      listFiles: { type: 'boolean', alias: 'l' },
      patterns: { type: 'string', alias: 'p', isMultiple: true },
      root: { type: 'string', default: process.cwd() },
    },
    importMeta: import.meta,
  }
);

if (cli.flags.help) {
  cli.showHelp(0);
}

async function main(cli) {
  const projectPath = dirname(cli.dockerFile);

  const [dependencyFiles, packageFiles, metaFiles] = await Promise.all([
    getFilesFromPnpmSelector(`{${projectPath}}^...`, cli.root, {
      extraPatterns: cli.extraPatterns,
    }),
    getFilesFromPnpmSelector(`{${projectPath}}`, cli.root, {
      extraPatterns: cli.extraPatterns.concat([`!${cli.dockerFile}`]),
    }),
    getMetafilesFromPnpmSelector(`{${projectPath}}...`, cli.root, {
      extraPatterns: cli.extraPatterns,
    }),
  ]);

  await withTmpdir(async (tmpdir) => {
    await Promise.all([
      fs.copyFile(cli.dockerFile, join(tmpdir, 'Dockerfile')),
      copyFiles(dependencyFiles, join(tmpdir, 'deps')),
      copyFiles(metaFiles, join(tmpdir, 'meta')),
      copyFiles(packageFiles, join(tmpdir, 'pkg')),
    ]);

    const files = await getFiles(tmpdir);
    if (cli.listFiles) {
      for await (const path of files) console.log(path);
    } else {
      await pipe(createTar({ gzip: true, cwd: tmpdir }, files), process.stdout);
    }
  });
}

await parseCli(cli)
  .then(main)
  .catch((err) => {
    throw err;
  });

async function fileExists(path) {
  try {
    await fs.stat(path);
  } catch (err) {
    return false;
  }

  return true;
}

async function getFilesFromPnpmSelector(selector, cwd, options = {}) {
  const projectPaths = await getPackagePathsFromPnpmSelector(selector, cwd);
  const patterns = projectPaths.concat(options.extraPatterns || []);

  return globby(patterns, { cwd, dot: true, gitignore: true });
}

async function getMetafilesFromPnpmSelector(selector, cwd, options = {}) {
  const [rootMetas, projectMetas] = await Promise.all([
    globby(
      [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'nx.json',
        'tsconfig.json',
        'tsconfig.base.json',
        'tsconfig.build.json',
        '.npmrc',
        'lerna.json',
        '.npmrc-cloud',
      ],
      { cwd, dot: true, gitignore: true }
    ),
    getPackagePathsFromPnpmSelector(selector, cwd).then((paths) => {
      const patterns = paths.map((p) => `${p}/**/package.json`).concat(options.extraPatterns || []);

      return globby(patterns, { cwd, dot: true, gitignore: true });
    }),
  ]);

  return rootMetas.concat(projectMetas);
}

async function getPackagePathsFromPnpmSelector(selector, cwd) {
  const projects = await readProjects(cwd, [parsePackageSelector(selector, cwd)]);

  return Object.keys(projects.selectedProjectsGraph).map((p) => relative(cwd, p).replace(/\\/g, '/'));
}

async function parseCli({ input, flags }) {
  const dockerFile = input.shift();
  if (!dockerFile) throw new Error('Must specify the path to Dockerfile');
  if (!(await fileExists(dockerFile))) throw new Error(`Dockerfile not found: ${dockerFile}`);

  return {
    dockerFile,
    extraPatterns: flags.patterns,
    listFiles: flags.listFiles,
    root: flags.root,
  };
}

async function withTmpdir(callable) {
  const tmpdir = await fs.mkdtemp(join(os.tmpdir(), SCRIPT_PATH));
  let result;
  try {
    result = await callable(tmpdir);
  } finally {
    await fs.rm(tmpdir, { recursive: true });
  }

  return result;
}

async function getFiles(dir) {
  async function* yieldFiles(dirPath) {
    const paths = await fs.readdir(dirPath, { withFileTypes: true });
    for (const path of paths) {
      const res = join(dirPath, path.name);
      if (path.isDirectory()) {
        yield* yieldFiles(res);
      } else {
        yield res;
      }
    }
  }

  const files = [];
  for await (const f of yieldFiles(dir)) {
    files.push(relative(dir, f));
  }

  return files;
}

async function copyFiles(files, dstDir) {
  return Promise.all(
    files.map((f) => {
      const dst = join(dstDir, f);

      return fs.mkdir(dirname(dst), { recursive: true }).then(() => fs.copyFile(f, dst));
    })
  );
}
