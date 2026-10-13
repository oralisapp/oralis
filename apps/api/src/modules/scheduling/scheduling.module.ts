import { Module } from '@nestjs/common';
import { PatientsModule } from '../patients/patients.module';
import { AppointmentLinksService } from './appointment-links.service';
import { PublicAppointmentLinksController, SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [PatientsModule],
  controllers: [SchedulingController, PublicAppointmentLinksController],
  providers: [SchedulingService, WaitlistService, AppointmentLinksService],
  exports: [SchedulingService, WaitlistService],
})
export class SchedulingModule {}
