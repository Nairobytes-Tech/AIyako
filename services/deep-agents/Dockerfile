FROM python:3.12-slim
WORKDIR /app
COPY services/deep-agents/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/deep-agents .
COPY prompts ./prompts
EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
