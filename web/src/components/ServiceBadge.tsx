/** Ticket-letter badge used as the icon for a service (services are configurable). */
export function ServiceBadge({ code, size = 'md', tone = 'light' }: { code: string; size?: 'sm' | 'md' | 'lg'; tone?: 'light' | 'solid' | 'dark' }) {
  const sizes = { sm: 'h-6 w-6 text-xs', md: 'h-9 w-9 text-base', lg: 'h-12 w-12 text-xl' };
  const tones = {
    light: 'bg-primary-lighter text-primary-dark',
    solid: 'bg-primary text-white',
    dark: 'bg-white/10 text-primary-light ring-1 ring-white/20',
  };
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-extrabold ${sizes[size]} ${tones[tone]}`} aria-hidden="true">
      {code}
    </span>
  );
}
