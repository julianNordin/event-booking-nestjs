import { forgetContainer } from './container';

export default async function globalTeardown(): Promise<void> {
  const container = forgetContainer();
  await container?.stop();
}
