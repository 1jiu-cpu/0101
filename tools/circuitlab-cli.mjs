#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { invokeTool, TOOL_SCHEMAS } from '../src/tooling.js';

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[key] = true;
        else { flags[key] = next; i++; }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function loadCircuitInput(fileArg, flags) {
  if (flags.example) return { example: flags.example };
  if (flags.netlist) return { netlist: flags.netlist, title: flags.title };
  if (flags.description) return { description: flags.description };
  if (fileArg) {
    const abs = resolve(fileArg);
    const text = await readFile(abs, 'utf8');
    const ext = extname(abs).toLowerCase();
    if (ext === '.svg' || text.trimStart().startsWith('<svg')) return { svg: text };
    if (ext === '.json' || text.trimStart().startsWith('{')) return { circuit: JSON.parse(text) };
    return { netlist: text, title: flags.title || abs.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') };
  }
  const stdin = (await readStdin()).trim();
  if (stdin) {
    if (stdin.startsWith('{')) return { circuit: JSON.parse(stdin) };
    if (stdin.startsWith('<svg')) return { svg: stdin };
    return { netlist: stdin };
  }
  throw Error('请提供电路文件路径、--example <id>、--netlist "..." 或通过标准输入传入电路。');
}

async function runMcpServer() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const writeMsg = msg => process.stdout.write(JSON.stringify(msg) + '\n');

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      writeMsg({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const { id, method, params } = req;
    if (method === 'notifications/initialized') continue;
    try {
      if (method === 'initialize') {
        writeMsg({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'circuitlab', version: '1.0.0' },
          },
        });
      } else if (method === 'ping') {
        writeMsg({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        writeMsg({ jsonrpc: '2.0', id, result: { tools: TOOL_SCHEMAS } });
      } else if (method === 'tools/call') {
        const result = invokeTool(params?.name, params?.arguments || {});
        writeMsg({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          },
        });
      } else {
        writeMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      if (method === 'tools/call') {
        writeMsg({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          },
        });
      } else {
        writeMsg({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
      }
    }
  }
}

async function writeStepArtifacts(outDir, steps, finalCircuit) {
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  for (const step of steps) {
    const prefix = `step-${String(step.index).padStart(2, '0')}-${step.rule}`;
    if (step.beforeSvg) await writeFile(resolve(dir, `${prefix}-before.svg`), step.beforeSvg, 'utf8');
    if (step.afterSvg) await writeFile(resolve(dir, `${prefix}-after.svg`), step.afterSvg, 'utf8');
    await writeFile(resolve(dir, `${prefix}.json`), JSON.stringify(step, null, 2), 'utf8');
  }
  if (finalCircuit) {
    await writeFile(resolve(dir, 'final.circuit.json'), JSON.stringify(finalCircuit, null, 2), 'utf8');
  }
}

function printUsage() {
  console.log([
    'CircuitLab CLI & LLM Tool Interface',
    '',
    'Usage:',
    '  node tools/circuitlab-cli.mjs tools',
    '  node tools/circuitlab-cli.mjs mcp',
    '  node tools/circuitlab-cli.mjs call <toolName> [--json \'{...}\' | --input payload.json]',
    '  node tools/circuitlab-cli.mjs read [file] [--example id] [--netlist "..."]',
    '  node tools/circuitlab-cli.mjs validate [file] [--example id] [--check-solve dc|ac|both]',
    '  node tools/circuitlab-cli.mjs analyze [file] [--example id] [--mode dc|ac|thevenin|...]',
    '  node tools/circuitlab-cli.mjs topology [file] [--example id]',
    '  node tools/circuitlab-cli.mjs reduce-options [file] [--example id] [--preserve-named]',
    '  node tools/circuitlab-cli.mjs reduce-step [file] [--example id] [--index N] [--rule R] [--render-svg] [--out-dir dir]',
    '  node tools/circuitlab-cli.mjs reduce-auto [file] [--example id] [--max-steps N] [--preserve-named] [--preserve-nodes a,b] [--no-bridge-balance] [--render-svg] [--out-dir dir] [--format json|markdown]',
    '  node tools/circuitlab-cli.mjs verify <beforeFile> <afterFile>',
    '  node tools/circuitlab-cli.mjs render [file] [--example id] [--auto-layout] [--out file.svg]',
  ].join('\n'));
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];
  if (!cmd || cmd === 'help' || flags.help) {
    printUsage();
    return;
  }

  if (cmd === 'mcp') {
    await runMcpServer();
    return;
  }

  if (cmd === 'tools') {
    console.log(JSON.stringify({ ok: true, tools: TOOL_SCHEMAS }, null, 2));
    return;
  }

  if (cmd === 'call') {
    const toolName = positionals[1];
    if (!toolName) throw Error('请指定工具名称，例如 circuit_reduce_auto。');
    let payload = {};
    if (flags.input) payload = JSON.parse(await readFile(resolve(flags.input), 'utf8'));
    else if (flags.json) payload = JSON.parse(flags.json);
    else {
      const stdin = (await readStdin()).trim();
      if (stdin) payload = JSON.parse(stdin);
    }
    const result = invokeTool(toolName, payload);
    console.log(JSON.stringify({ ok: true, tool: toolName, result }, null, 2));
    return;
  }

  const preserveNodes = typeof flags['preserve-nodes'] === 'string'
    ? flags['preserve-nodes'].split(',').map(s => s.trim()).filter(Boolean)
    : [];

  if (cmd === 'verify') {
    const beforeIn = await loadCircuitInput(positionals[1], {});
    const afterIn = await loadCircuitInput(positionals[2], {});
    const beforeDoc = invokeTool('circuit_read', beforeIn).circuit;
    const afterDoc = invokeTool('circuit_read', afterIn).circuit;
    const result = invokeTool('circuit_verify_equivalence', { before: beforeDoc, after: afterDoc });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }

  const input = await loadCircuitInput(positionals[1], flags);

  if (cmd === 'read') {
    console.log(JSON.stringify({ ok: true, result: invokeTool('circuit_read', input) }, null, 2));
    return;
  }
  if (cmd === 'validate') {
    const result = invokeTool('circuit_validate', {
      ...input,
      checkSolve: flags['check-solve'] || 'none',
      frequency: flags.frequency ? Number(flags.frequency) : 50,
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  if (cmd === 'analyze') {
    const result = invokeTool('circuit_analyze', {
      ...input,
      mode: flags.mode || 'dc',
      frequency: flags.frequency ? Number(flags.frequency) : 1000,
      node: flags.node,
      positive: flags.positive,
      negative: flags.negative,
      source: flags.source,
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  if (cmd === 'topology') {
    const result = invokeTool('circuit_detect_topology', { ...input, preserveNodes });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  if (cmd === 'reduce-options') {
    const result = invokeTool('circuit_reduce_options', {
      ...input,
      preserveNodes,
      ...(flags['preserve-named'] !== undefined ? { preserveNamed: Boolean(flags['preserve-named']) } : {}),
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  if (cmd === 'reduce-step') {
    const renderSvg = Boolean(flags['render-svg'] || flags['out-dir']);
    const result = invokeTool('circuit_reduce_step', {
      ...input,
      index: flags.index !== undefined ? Number(flags.index) : undefined,
      rule: flags.rule,
      preserveNodes,
      ...(flags['preserve-named'] !== undefined ? { preserveNamed: Boolean(flags['preserve-named']) } : {}),
      renderSvg,
    });
    if (flags['out-dir'] && result.step) {
      await writeStepArtifacts(flags['out-dir'], [result.step], result.circuit);
    }
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  if (cmd === 'reduce-auto') {
    const renderSvg = Boolean(flags['render-svg'] || flags['out-dir']);
    const result = invokeTool('circuit_reduce_auto', {
      ...input,
      maxSteps: flags['max-steps'] ? Number(flags['max-steps']) : 30,
      preserveNodes,
      ...(flags['preserve-named'] !== undefined ? { preserveNamed: Boolean(flags['preserve-named']) } : {}),
      allowBridgeBalance: !flags['no-bridge-balance'],
      renderSvg,
    });
    if (flags['out-dir']) {
      await writeStepArtifacts(flags['out-dir'], result.steps, result.finalCircuit);
      await writeFile(resolve(flags['out-dir'], 'report.md'), result.markdown, 'utf8');
    }
    if (flags.format === 'markdown') {
      console.log(result.markdown);
    } else {
      console.log(JSON.stringify({ ok: true, result }, null, 2));
    }
    return;
  }
  if (cmd === 'render') {
    const highlight = flags['highlight-elements']
      ? {
        elements: flags['highlight-elements'].split(',').map(s => s.trim()).filter(Boolean),
        ports: flags['highlight-ports'] ? flags['highlight-ports'].split(',').map(s => s.trim()).filter(Boolean) : [],
        mode: flags['highlight-mode'] || 'before',
        label: flags['highlight-label'] || '',
      }
      : undefined;
    const result = invokeTool('circuit_render', {
      ...input,
      autoLayout: Boolean(flags['auto-layout']),
      embedModel: !flags['no-embed'],
      highlight,
    });
    if (flags.out) {
      await writeFile(resolve(flags.out), result.svg, 'utf8');
      console.log(JSON.stringify({ ok: true, out: resolve(flags.out), bounds: result.bounds, quality: result.quality, routedValid: result.routedValid }, null, 2));
    } else {
      process.stdout.write(result.svg);
    }
    return;
  }

  throw Error(`未知子命令：${cmd}。运行 --help 查看用法。`);
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
});
