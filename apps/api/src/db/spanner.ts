import { Spanner } from '@google-cloud/spanner';
import { config } from '../config';

// When SPANNER_EMULATOR_HOST is set, the client talks to the emulator
// automatically (no credentials needed). In Cloud Run it uses ADC.
export const spanner = new Spanner({ projectId: config.projectId });
export const instance = spanner.instance(config.spanner.instance);
export const database = instance.database(config.spanner.database);
