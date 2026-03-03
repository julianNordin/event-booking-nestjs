import { EnvironmentValidationError, NodeEnv, validateEnv } from './env.validation';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://events:events@localhost:5432/events',
  DATABASE_POOL_MAX: '20',
};

describe('validateEnv', () => {
  describe('when the environment is complete and well formed', () => {
    it('returns the values coerced to their declared types', () => {
      const env = validateEnv(valid);

      expect(env.NODE_ENV).toBe(NodeEnv.Test);
      expect(env.PORT).toBe(3000);
      expect(env.DATABASE_POOL_MAX).toBe(20);
      expect(env.DATABASE_URL).toBe('postgresql://events:events@localhost:5432/events');
    });

    it('coerces numeric strings to numbers rather than leaving them as strings', () => {
      // process.env values are always strings; anything downstream that does
      // arithmetic on PORT or sizes a pool from DATABASE_POOL_MAX needs numbers.
      const env = validateEnv(valid);

      expect(typeof env.PORT).toBe('number');
      expect(typeof env.DATABASE_POOL_MAX).toBe('number');
    });

    it('applies defaults for the optional variables', () => {
      const env = validateEnv({ DATABASE_URL: valid.DATABASE_URL });

      expect(env.NODE_ENV).toBe(NodeEnv.Development);
      expect(env.PORT).toBe(3000);
      expect(env.DATABASE_POOL_MAX).toBe(10);
    });

    it('accepts both the postgres:// and postgresql:// schemes', () => {
      expect(() => validateEnv({ DATABASE_URL: 'postgres://u:p@db:5432/events' })).not.toThrow();
      expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@db:5432/events' })).not.toThrow();
    });
  });

  describe('when the environment is broken', () => {
    it('throws when DATABASE_URL is missing entirely', () => {
      expect(() => validateEnv({})).toThrow(EnvironmentValidationError);
    });

    it('names the offending variable in the message', () => {
      // A boot failure that says only "validation failed" costs an engineer the
      // exact minutes this test exists to save.
      expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    });

    it.each([
      ['an empty string', ''],
      ['a bare hostname', 'localhost:5432'],
      ['the wrong scheme', 'https://localhost:5432/events'],
      ['mysql', 'mysql://u:p@localhost:3306/events'],
    ])('rejects a DATABASE_URL that is %s', (_label, url) => {
      expect(() => validateEnv({ ...valid, DATABASE_URL: url })).toThrow(
        EnvironmentValidationError,
      );
    });

    it.each([
      ['not a number', 'not-a-port'],
      ['zero', '0'],
      ['above the 16-bit range', '65536'],
      ['fractional', '3000.5'],
    ])('rejects a PORT that is %s', (_label, port) => {
      expect(() => validateEnv({ ...valid, PORT: port })).toThrow(EnvironmentValidationError);
    });

    it('rejects a NODE_ENV outside the known set', () => {
      expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
        EnvironmentValidationError,
      );
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['implausibly large', '1000'],
    ])('rejects a DATABASE_POOL_MAX that is %s', (_label, poolMax) => {
      expect(() => validateEnv({ ...valid, DATABASE_POOL_MAX: poolMax })).toThrow(
        EnvironmentValidationError,
      );
    });

    it('reports every broken variable at once rather than only the first', () => {
      // Three variables are wrong here. Reporting one, restarting, and finding
      // the next is three round trips for information that was available at
      // once, so the assertion is on the set of variables named, not on a
      // message count (one variable can breach several constraints).
      try {
        validateEnv({ NODE_ENV: 'staging', PORT: '0' });
        throw new Error('expected validateEnv to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentValidationError);
        const { failures } = error as EnvironmentValidationError;
        const named = new Set(failures.map((failure) => failure.split(' ')[0]));
        expect(named).toEqual(new Set(['NODE_ENV', 'PORT', 'DATABASE_URL']));
      }
    });
  });
});
