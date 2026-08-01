import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { Task } from '../common/types/task.types';
import type { AuthContext } from '../common/types/user.types';
import {
  type CreateTaskDto,
  type ListTasksQueryDto,
  type UpdateTaskDto,
  createTaskSchema,
  listTasksQuerySchema,
  updateTaskSchema,
} from '../dto/task.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { TaskService } from '../services/task.service';

/**
 * The signed-in account's tasks (CONTRACT.md §16.1-§16.4).
 *
 * No route accepts a user id. The account comes from the verified token and is applied as a query
 * constraint in the repository, so a task belonging to someone else is not forbidden — it simply
 * is not found (ADR-010). That is why every miss here is a 404 and never a 403: a 403 would confirm
 * that the id exists.
 */
@Controller('tasks')
@UseGuards(JwtGuard)
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listTasksQuerySchema)) query: ListTasksQueryDto,
  ): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    return this.tasks.listTasks(auth.userId, query);
  }

  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createTaskSchema)) dto: CreateTaskDto,
  ): Promise<{ task: Task }> {
    return { task: await this.tasks.createTask(auth.userId, dto) };
  }

  @Patch(':id')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateTaskSchema)) dto: UpdateTaskDto,
  ): Promise<{ task: Task }> {
    return { task: await this.tasks.updateTask(auth.userId, id, dto) };
  }

  /**
   * Hard delete. The task's recorded sessions survive with their title snapshots — deleting a
   * label has never been a reason to delete the work done under it.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.tasks.deleteTask(auth.userId, id);
  }
}
