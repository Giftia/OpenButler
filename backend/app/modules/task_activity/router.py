"""Mounted only by the authenticated native Preview composition."""
from fastapi import APIRouter, Depends, HTTPException, Response
from uuid import UUID
from . import models
from .service import TaskError


def create_task_router(service):
    def private(response: Response):
        response.headers['Cache-Control'] = 'private, no-store'
    router = APIRouter(dependencies=[Depends(private)])

    @router.on_event('shutdown')
    def shutdown():
        if not service.close():
            raise RuntimeError('task_worker_shutdown_timeout')

    def call(method, *args):
        try:
            return method(*args)
        except TaskError as error:
            raise HTTPException(error.status, detail=error.code) from None

    @router.get('/api/tasks')
    def tasks(include_archived: bool = False):
        return call(service.list_tasks, include_archived)

    @router.post('/api/tasks')
    def create_task(request: models.TaskCreate):
        return call(service.create_task, request)

    @router.get('/api/tasks/{task_id}')
    def detail(task_id: str):
        return call(service.detail, task_id)

    @router.patch('/api/tasks/{task_id}')
    def edit(task_id: str, request: models.TaskEdit):
        return call(service.edit_task, task_id, request)

    @router.put('/api/tasks/{task_id}/activities/{activity_id}')
    def link(task_id: str, activity_id: str, request: models.LinkEdit):
        return call(service.link_activity, task_id, activity_id, request)

    @router.put('/api/tasks/{task_id}/checkpoint')
    def checkpoint(task_id: str, request: models.CheckpointEdit):
        return call(service.checkpoint, task_id, request)

    @router.post('/api/tasks/{task_id}/resources')
    def resource(task_id: str, request: models.ResourceCreate):
        return call(service.resource, task_id, request)

    @router.post('/api/tasks/{task_id}/merge')
    def merge(task_id: str, request: models.MergeRequest):
        return call(service.merge, task_id, request)

    @router.post('/api/tasks/{task_id}/unmerge')
    def unmerge(task_id: str, request: models.Versioned):
        return call(service.unmerge, task_id, request)

    @router.put('/api/tasks/{task_id}/runtime-goal')
    def runtime_bridge(task_id: str, request: models.RuntimeBridge):
        return call(service.runtime_bridge, task_id, request)

    @router.get('/api/task-activity/settings')
    def settings():
        return call(service.settings)

    @router.put('/api/task-activity/settings')
    def configure(request: models.SettingsEdit):
        return call(service.set_settings, request)

    @router.post('/api/task-activity/sync')
    def sync(request: models.SyncStart, response: Response):
        result = call(service.start_sync, request)
        response.status_code = 202 if result['operation'] and not result['operation']['settled'] else 200
        return result

    @router.get('/api/task-activity/sync')
    def sync_latest():
        return call(service.sync_operation)

    @router.get('/api/task-activity/sync/{command_id}')
    def sync_receipt(command_id: UUID):
        return call(service.sync_operation, command_id)

    @router.post('/api/task-activity/sync/{command_id}/stop')
    def sync_stop(command_id: UUID, request: models.SyncStop, response: Response):
        result = call(service.stop_sync, command_id)
        response.status_code = 202 if result['operation'] and not result['operation']['settled'] else 200
        return result

    @router.get('/api/task-activity/activities')
    def activities():
        return call(service.list_activities)

    @router.post('/api/task-activity/activities')
    def create_activity(request: models.ActivityCreate):
        return call(service.create_activity, request)

    @router.get('/api/task-activity/discoveries')
    def discoveries():
        return call(service.discoveries)

    @router.post('/api/task-activity/discoveries/{discovery_id}/resolve')
    def resolve(discovery_id: str, request: models.DiscoveryResolution):
        return call(service.resolve, discovery_id, request)

    return router
