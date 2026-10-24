// Pure check (no DNS): is a listen address reachable only from this machine?
import net from 'node:net';

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/**
 * True for `localhost`, any address in 127.0.0.0/8, and `::1`, in any IPv6
 * spelling including the IPv4-mapped forms (`::ffff:127.0.0.1`). Any other
 * hostname counts as open to the network: a DNS name such as
 * `127.corp.example` can resolve anywhere.
 */
export function isLoopback(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  const family = net.isIP(host);
  if (family === 0) return false;
  return loopback.check(host, family === 4 ? 'ipv4' : 'ipv6');
}
