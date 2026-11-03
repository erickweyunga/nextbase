import { newNextHandler } from '@nextbasejs/next';
import { nextbase } from '@/lib/nextbase';

export const { GET } = newNextHandler(nextbase);
