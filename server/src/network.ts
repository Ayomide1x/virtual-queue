import fs from 'node:fs';
import os from 'node:os';

export function runningInDocker(): boolean {
  return fs.existsSync('/.dockerenv');
}

/**
 * Best guess at the IPv4 address phones on the same Wi-Fi can reach.
 * Returns null inside Docker (the container only sees its own bridge IP),
 * unless HOST_IP is provided.
 */
export function getLanIp(hostIp?: string): string | null {
  if (hostIp) return hostIp;
  if (runningInDocker()) return null;

  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  const score = ({ name, address }: { name: string; address: string }) => {
    if (/^(docker|br-|veth|vmnet|utun|bridge|vboxnet)/.test(name)) return 0;
    if (address.startsWith('192.168.')) return 3;
    if (address.startsWith('10.')) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 1;
    return 1;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]?.address ?? null;
}
