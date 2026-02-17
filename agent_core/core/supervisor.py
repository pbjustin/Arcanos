import asyncio


class Supervisor:
    def __init__(self, kernel):
        self.kernel = kernel

    async def start(self):
        await self.kernel.backend.register()

        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._heartbeat_loop())
            tg.create_task(self._task_loop())

    async def _heartbeat_loop(self):
        while True:
            await asyncio.sleep(5)
            await self.kernel.send_heartbeat()

    async def _task_loop(self):
        while True:
            await asyncio.sleep(2)
            await self.kernel.process_task_cycle()
