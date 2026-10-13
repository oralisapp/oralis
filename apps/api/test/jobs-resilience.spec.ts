import { Logger } from '@nestjs/common';
import { Clock } from '../src/common/clock';
import type { Db } from '../src/db/db';
import { JobsService } from '../src/modules/platform/jobs.service';

describe('Background queue resilience', () => {
  it('contains a transient database failure and processes the next cycle', async () => {
    const transaction = jest.fn().mockRejectedValueOnce(new Error('connection unavailable')).mockResolvedValue(null);
    const where = jest.fn().mockResolvedValue([]);
    const db = { transaction, delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const jobs = new JobsService(db, new Clock());
      await expect(jobs.tick()).resolves.toBeUndefined();
      expect(logger).toHaveBeenCalledWith('Ciclo da fila interrompido. Verifique a conexão com o banco; nova tentativa no próximo ciclo.');
      await expect(jobs.tick()).resolves.toBeUndefined();
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(where).toHaveBeenCalledTimes(1);
    } finally { logger.mockRestore(); }
  });
});
