import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names, letting a later Tailwind class win over an earlier one that sets the same thing. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
