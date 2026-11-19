import { forwardWhatsApp } from '@/lib/whatsapp-webhook';
export function POST(request: Request) {
  return forwardWhatsApp(request, 'webhook');
}
