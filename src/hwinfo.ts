// src/hwinfo.ts — 硬件检测（P6 本地模式引导）：显存/内存 → 推荐模型档位
// 不引入 systeminformation（保持主进程零 npm 依赖）；Windows 上用 PowerShell/WMI + 注册表。
// 坑：Win32_VideoController.AdapterRAM 是 UInt32，>4GB 会回绕——所以优先读注册表
// HardwareInformation.qwMemorySize（QWORD，无回绕），WMI 只作回退。
// 解析逻辑放本模块（可单测）；命令执行在主进程（electron/main.ts）。

export const HWINFO_PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs) { $out.totalRamGB = [math]::Round([double]$cs.TotalPhysicalMemory / 1GB, 1) } else { $out.totalRamGB = 0 }
$gpus = @()
$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
for ($i = 0; $i -lt 16; $i++) {
  $key = $base + '\\' + ('{0:0000}' -f $i)
  $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $v = $p.'HardwareInformation.qwMemorySize'
  $bytes = 0L
  if ($v -is [byte[]]) { $bytes = [long][System.BitConverter]::ToUInt64($v, 0) }
  elseif ($v -is [uint64] -or $v -is [int64]) { $bytes = [long][uint64]$v }
  if ($bytes -gt 0) { $gpus += [pscustomobject]@{ name = [string]$p.'DriverDesc'; vram = [math]::Round($bytes / 1GB, 1) } }
}
if ($gpus.Count -eq 0) {
  Get-CimInstance Win32_VideoController | ForEach-Object {
    if ($_.AdapterRAM -and $_.AdapterRAM -gt 0) { $gpus += [pscustomobject]@{ name = [string]$_.Name; vram = [math]::Round([double]$_.AdapterRAM / 1GB, 1) } }
  }
}
$out.gpus = @($gpus | Sort-Object { $_.vram } -Descending)
[pscustomobject]$out | ConvertTo-Json -Compress
`;

export interface HwRawGpu {
  name?: string;
  vram?: number;
}

export interface HwRaw {
  totalRamGB?: number;
  gpus?: HwRawGpu[];
}

/** 解析 PowerShell 输出的 JSON → HardwareInfo（供 renderer 展示 + recommendModel 档位） */
export function parseHwInfo(raw: string | null | undefined): { totalRamGB: number | null; vramGB: number | null; gpuName: string | null } {
  if (!raw) return { totalRamGB: null, vramGB: null, gpuName: null };
  let obj: HwRaw;
  try {
    obj = JSON.parse(raw) as HwRaw;
  } catch {
    return { totalRamGB: null, vramGB: null, gpuName: null };
  }
  const totalRamGB = typeof obj.totalRamGB === 'number' && obj.totalRamGB > 0 ? Math.round(obj.totalRamGB * 10) / 10 : null;
  const gpus = Array.isArray(obj.gpus) ? obj.gpus : [];
  const top = gpus
    .filter((g) => typeof g.vram === 'number' && g.vram > 0)
    .sort((a, b) => (b.vram ?? 0) - (a.vram ?? 0))[0];
  return {
    totalRamGB,
    vramGB: top ? Math.round((top.vram ?? 0) * 10) / 10 : null,
    gpuName: top?.name ? String(top.name) : null,
  };
}
