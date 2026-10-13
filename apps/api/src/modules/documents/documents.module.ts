import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, Public, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { DocumentsService, documentUpdateSchema, templateSchema, type UploadedFile as Upload, uploadMetaSchema } from './documents.service';
import { MAX_UPLOAD_BYTES, StorageService } from './storage.service';

const upload = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

@Controller('orgs/:orgId')
class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get('patients/:patientId/documents')
  @RequirePermission('patients.read')
  list(@Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.docs.list(tenant, patientId);
  }

  @Post('patients/:patientId/documents')
  @RequirePermission('patients.read')
  @UseInterceptors(upload)
  create(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @UploadedFile() file: Upload | undefined, @Meta() meta: RequestMeta) {
    return this.docs.upload(auth, tenant, patientId, parse(uploadMetaSchema, body), file, meta);
  }

  @Post('patients/:patientId/documents/from-template')
  @RequirePermission('clinical.write')
  fromTemplate(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    const input = parse(z.object({ templateId: z.uuid(), sharedWithPatient: z.boolean().default(false) }), body);
    return this.docs.fromTemplate(auth, tenant, patientId, input.templateId, input.sharedWithPatient, meta);
  }

  @Post('documents/:id/versions')
  @RequirePermission('patients.read')
  @UseInterceptors(upload)
  addVersion(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Upload | undefined, @Meta() meta: RequestMeta) {
    return this.docs.addVersion(auth, tenant, id, file, meta);
  }

  @Put('documents/:id')
  @RequirePermission('patients.read')
  update(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.docs.update(auth, tenant, id, parse(documentUpdateSchema, body), meta);
  }

  @Delete('documents/:id')
  @RequirePermission('patients.read')
  archive(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.docs.archive(auth, tenant, id, meta);
  }

  @Post('documents/:id/download')
  @RequirePermission('patients.read')
  download(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.docs.downloadLink(auth, tenant, id, parse(z.object({ version: z.number().int().min(1).optional() }), body).version, meta);
  }

  @Get('document-templates')
  @RequirePermission('clinical.read')
  templates(@Tenant() tenant: TenantContext) {
    return this.docs.templates(tenant);
  }

  @Post('document-templates')
  @RequirePermission('clinical.write')
  createTemplate(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown) {
    return this.docs.saveTemplate(auth, tenant, null, parse(templateSchema, body));
  }

  @Put('document-templates/:id')
  @RequirePermission('clinical.write')
  updateTemplate(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.docs.saveTemplate(auth, tenant, id, parse(templateSchema, body));
  }
}

/** Download por link assinado e temporário. Sem assinatura válida, o arquivo não existe. */
@Controller('files')
class FilesController {
  constructor(private readonly docs: DocumentsService) {}

  @Get(':versionId')
  @Public()
  async get(@Param('versionId') versionId: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const f = await this.docs.serveSigned(versionId, exp ?? '', sig ?? '');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `${f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.send(f.data);
  }
}

@Module({ controllers: [DocumentsController, FilesController], providers: [DocumentsService, StorageService], exports: [DocumentsService, StorageService] })
export class DocumentsModule {}
