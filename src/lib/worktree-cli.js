// HISTORICAL ONLY: no supported runtime callers since #44; see docs/agent-owned-resources.md.
/** CLI parser kept independent from the coordinator's lifecycle wiring. */
export async function runWorktreeCli(argv, { manager, output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`) }) {
  const [action, ...args] = argv;
  const boundary = args.indexOf('--');
  const flags = boundary < 0 ? args : args.slice(0, boundary);
  const values = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--acknowledge-stopped') { values.acknowledgedStopped = true; continue; }
    if (!['--task', '--generation', '--resource'].includes(flags[i]) || !flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error('invalid task execution arguments');
    const key = flags[i].slice(2);
    if (values[key]) throw new Error('duplicate task execution argument');
    values[key] = flags[++i];
  }
  const { task, generation, resource } = values;
  if (!task || !generation) throw new Error('--task and --generation are required');
  let result;
  if (action === 'locate' && resource) result = await manager.locate(task, generation, resource);
  else if (action === 'exec' && resource && boundary >= 0) result = await manager.run(task, generation, resource, args.slice(boundary + 1));
  else if (action === 'quiesce') result = await manager.quiesce(task, generation, values);
  else if (action === 'inspect') result = manager.inspect(task);
  else throw new Error('use locate/exec --resource, quiesce --acknowledge-stopped, or inspect');
  output(result);
  return result;
}
