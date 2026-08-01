import { Module } from '@nestjs/common';
import { TaskController } from '../controllers/task.controller';
import { TaskRepository } from '../repositories/task.repository';
import { TaskService } from '../services/task.service';
import { AuthModule } from './auth.module';

/*
 * Tasks — the work a focus session runs against.
 *
 * Imports AuthModule for JwtGuard, as every feature module does.
 *
 * TaskService is exported so the session recorder can ask whether a task exists without reaching
 * into the tasks table; TaskRepository is deliberately NOT exported, so this module remains the
 * only thing that touches it (ADR-020). What crosses the boundary is a question, not a table.
 */
@Module({
  imports: [AuthModule],
  controllers: [TaskController],
  providers: [TaskService, TaskRepository],
  exports: [TaskService],
})
export class TaskModule {}
