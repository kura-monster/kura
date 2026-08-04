#!/usr/bin/env python3
import json
from pathlib import Path

intrinsics = Path('lib/system-native-intrinsics.mjs')
source = intrinsics.read_text(encoding='utf-8')
import_line = "import { compileSchedulerIntrinsic } from './system-native-atomics.mjs';\n"
anchor = "import { fail, isPointer, safeName } from './system-native-common.mjs';\n"
if import_line not in source:
    if anchor not in source:
        raise SystemExit('Native intrinsic import anchor is missing.')
    source = source.replace(anchor, anchor + import_line, 1)
call = "  const schedulerIntrinsic = compileSchedulerIntrinsic(emitter, expression, path);\n  if (schedulerIntrinsic) return schedulerIntrinsic;\n"
path_anchor = "  const path = pathName(expression.callee);\n"
if call not in source:
    if source.count(path_anchor) != 1:
        raise SystemExit('Native intrinsic dispatch anchor is ambiguous.')
    source = source.replace(path_anchor, path_anchor + call, 1)
intrinsics.write_text(source, encoding='utf-8')

exports = Path('lib/system-native.mjs')
source = exports.read_text(encoding='utf-8')
block = """
export {
  DEFAULT_KERNEL_SCHEDULER_LAYOUT,
  createKernelSchedulerManifest,
  parseAcpiHpet,
  TicketSpinLockModel,
  SlabAllocatorModel,
  PriorityRoundRobinSchedulerModel,
  createContextSwitchAssembly,
  createKernelSchedulerSource,
  createSchedulerBuildPlan,
  emitSchedulerSupportObject,
  buildSchedulerKernel,
} from './system-kernel-scheduler.mjs';
"""
if "from './system-kernel-scheduler.mjs';" not in source:
    source += block
exports.write_text(source, encoding='utf-8')

package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
package['description'] = 'Kura v1 compiler with AI, LSP, native x86_64 SMP, memory management, and a scheduled kernel runtime'
package.setdefault('bin', {})['kr-scheduler'] = 'bin/kr-scheduler.mjs'
package.setdefault('exports', {})['./system/kernel-scheduler'] = './lib/system-kernel-scheduler.mjs'
keywords = package.setdefault('keywords', [])
for keyword in ['spinlock', 'hpet', 'lapic-timer', 'slab-allocator', 'kernel-thread', 'context-switch', 'scheduler', 'per-cpu']:
    if keyword not in keywords:
        keywords.append(keyword)
scripts = package.setdefault('scripts', {})
scheduler_test = 'node test/system-kernel-scheduler.mjs'
if scheduler_test not in scripts['test']:
    scripts['test'] += ' && ' + scheduler_test
for key in ['test:system', 'test:native', 'test:system-next']:
    if key in scripts and scheduler_test not in scripts[key]:
        scripts[key] += ' && ' + scheduler_test
scripts['test:kernel-scheduler'] = scheduler_test
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

lock_path = Path('package-lock.json')
lock = json.loads(lock_path.read_text(encoding='utf-8'))
root = lock['packages']['']
root.setdefault('bin', {})['kr-kernel'] = 'bin/kr-kernel.mjs'
root['bin']['kr-scheduler'] = 'bin/kr-scheduler.mjs'
lock_path.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')
