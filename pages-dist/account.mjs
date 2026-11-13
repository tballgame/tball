const domain = '@accounts.tball.invalid';
export const webApiKey = 'AIzaSyBsHh6yOd08IhB3Q4rjbxarS8DZGxi0xxo';

export function accountEmail(input) {
  const name = typeof input === 'string' ? input.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9_.-]{2,23}$/.test(name) ? name + domain : null;
}

export function accountName(email) {
  if (typeof email !== 'string' || !email.endsWith(domain)) return null;
  const name = email.slice(0, -domain.length);
  return accountEmail(name) === email ? name : null;
}
