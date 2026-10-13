import { Module } from '@nestjs/common';
import { CommunicationService } from './communication.service';
import { PatientProfileController } from './patient-profile.controller';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { PatientTimelineController } from './patient-timeline.controller';
import { PatientImportService } from './patient-import.service';
import { PatientMergeService } from './patient-merge.service';

@Module({
  controllers: [PatientsController, PatientProfileController, PatientTimelineController],
  providers: [PatientsService, CommunicationService, PatientImportService, PatientMergeService],
  exports: [PatientsService, CommunicationService],
})
export class PatientsModule {}
