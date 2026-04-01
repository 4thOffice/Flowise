import psycopg2
import sqlite3
import os
import re

# WARNING: this uses raw sql queries, so be mindful of sql injection attacks

CONNECTION_STR: str = "sqlite://./database.sqlite"
# CONNECTION_STR: str = "postgresql://username:password@hostname:5432/dbname"
# CONNECTION_STR: str = "postgresql://user:123@flowise:5432/flowise1"
DELETE_OLDER_THAN_N_DAYS: int = 30

REGEX_SQLITE: str = "sqlite://(.+)"
REGEX_POSTGRES: str = "postgresql://([^:@/]+):([^:@/]+)@([^:@/]+):([^:@/]+)/([^:@/]+)"
TABLE_TO_DATETIME_COLUMN: dict[str, str] = {
    "chat_message_feedback": "createdDate",
    "chat_message": "createdDate",
    "execution": "updatedDate",
}

def check_missing_tables(tables: list[str]):
    required_tables: list[str] = list(TABLE_TO_DATETIME_COLUMN.keys())
    missing_tables: list[str] = [req_table for req_table in required_tables if req_table not in tables]
    if missing_tables:
        raise Exception(f"Missing some required tables: {missing_tables}")

def run_postgres():
    print(f"Database type: postgres")
    username, password, hostname, port, dbname = re.fullmatch(REGEX_POSTGRES, CONNECTION_STR).groups()
    print(f"{username=}, {password=}, {hostname=}, {port=}, {dbname=}")
    with psycopg2.connect(
        host=hostname,
        port=port,
        user=username,
        database=dbname,
        password=password,
    ) as conn:
        cursor: psycopg2.extensions.cursor = conn.cursor()
        cursor.execute("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public';
        """)
        tables: list[str] = [x[0] for x in cursor.fetchall()]
        check_missing_tables(tables)
        for table, column in TABLE_TO_DATETIME_COLUMN.items():
            cursor.execute(f"""
                DELETE FROM {table}
                WHERE "{column}" < (NOW() - INTERVAL '{DELETE_OLDER_THAN_N_DAYS} days');
            """)
            print(f"{table}: deleting {cursor.rowcount} rows ...")
            conn.commit()
        print(f"Closing connection ...")

def run_sqlite():
    print(f"Database type: sqlite")
    path: str = re.fullmatch(REGEX_SQLITE, CONNECTION_STR).group(1)
    if os.path.exists(f"/{path}"):
        path = f"/{path}"
    elif not os.path.exists(path):
        raise Exception(f"Sqlite path not found: {path}")
    with sqlite3.connect(path) as conn:
        cursor: sqlite3.Cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables: list[str] = [table[0] for table in cursor.fetchall()]
        check_missing_tables(tables)
        for table, column in TABLE_TO_DATETIME_COLUMN.items():
            cursor.execute(f"""
                DELETE FROM {table}
                WHERE {column} < datetime("now", "-{DELETE_OLDER_THAN_N_DAYS} days");
            """)
            print(f"{table}: deleting {cursor.rowcount} rows ...")
            conn.commit()
        print(f"Closing connection ...")

def main():
    if re.fullmatch(REGEX_POSTGRES, CONNECTION_STR):
        run_postgres()
    elif re.fullmatch(REGEX_SQLITE, CONNECTION_STR):
        run_sqlite()
    else:
        raise Exception(f"Invalid connection string")
    print(f"Finished")

if __name__ == "__main__":
    main()

